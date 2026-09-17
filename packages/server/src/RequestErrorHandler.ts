import express from 'express';
import { STATUS_CODES } from 'http';
import { Logger } from '@proteinjs/logger';

type RequestFacts = {
  method: string;
  /** The request path with its query stripped. */
  path: string;
  userAgentFamily: string;
  /** The conditional request headers present, by name — a refusal like 412 or 416 is about these. */
  conditionalHeaders?: Record<string, string>;
  /** The declared `Content-Length`, when the request declared one. */
  contentLength?: number;
};

/**
 * The last layer of the request pipeline: every error a middleware or route hands to
 * `next(error)` lands here, so the process log carries the request's facts — instead of express's
 * default handler printing a bare `err.stack` to stderr and answering with an HTML page that
 * carries the stack. A log fed by stderr then shows only "PreconditionFailedError: Precondition
 * Failed" with no route, no method, no headers: nothing that says which client asked for what.
 *
 * Two kinds of error arrive:
 *
 *  - A REFUSED request — a 4xx `status` on the error, the http-errors convention the pipeline's
 *    own middlewares follow: the static router's 412 (a conditional request the file on disk can
 *    no longer satisfy — a client revalidating a file it held across a deploy that replaced it)
 *    and 416 (an unsatisfiable range); the body parser's 400 `request.aborted` (the sender hung
 *    up mid-body), 413 `entity.too.large`, 400 `entity.parse.failed`. The server did nothing
 *    wrong, so this is one WARN line, with the facts that say which client asked for what: the
 *    method and path, the user-agent family, the conditional headers that rode the request, the
 *    declared content length. Answered with the error's own status and — where the error exposes
 *    it — its message.
 *
 *  - A FAILED request — a 5xx status, or no status at all: one ERROR line carrying the error
 *    itself and the request's method and path; answered with the status and a generic body —
 *    never the message, never the stack.
 *
 * These errors precede any route, so no request metadata exists for a log writer to stamp
 * (`Request.setMetadata` is a route-level act): the facts ride the log line's own object.
 */
export class RequestErrorHandler {
  /** The headers that make a request conditional (RFC 9110 §13), lower-cased as node presents them. */
  private static readonly CONDITIONAL_HEADERS = [
    'if-match',
    'if-none-match',
    'if-modified-since',
    'if-unmodified-since',
    'if-range',
    'range',
  ];
  private static readonly HEADER_VALUE_MAX_LENGTH = 200;
  /**
   * Headers a layer stages before it fails, describing the representation it never sent: the
   * static router sets the file's type, ETag, Last-Modified and cache policy BEFORE it checks the
   * request's conditions. An error answer describes the error, never that representation.
   */
  private static readonly STAGED_REPRESENTATION_HEADERS = [
    'content-type',
    'content-length',
    'content-encoding',
    'content-language',
    'content-range',
    'content-disposition',
    'etag',
    'last-modified',
    'cache-control',
    'accept-ranges',
  ];
  /**
   * Coarse client families, first match wins: the webviews and bots before the browsers whose
   * tokens they also carry; Chrome before Safari (every Chrome carries the Safari token).
   */
  private static readonly USER_AGENT_FAMILIES: [string, RegExp][] = [
    ['bot', /bot|crawler|spider/],
    ['android-webview', /; wv\)/],
    // WebKit on iOS without the Safari token: an app's web view.
    ['ios-webview', /\b(iphone|ipad|ipod)\b(?!.*safari\/)/],
    ['edge', /\bedg(e|a|ios)?\//],
    ['opera', /\bopr\/|\bopera\b/],
    ['samsung', /samsungbrowser/],
    ['firefox', /\b(firefox|fxios)\//],
    ['chrome', /\b(chrome|crios|chromium)\//],
    ['safari', /\bsafari\//],
  ];

  constructor(private logger: Logger = new Logger({ name: 'Server' })) {}

  /** The express error middleware. Register it LAST: it handles the errors of every layer before it. */
  middleware(): express.ErrorRequestHandler {
    // Four declared parameters — that arity is how express tells an error middleware apart.
    return (error, request, response, next) => {
      const status = this.statusOf(error);
      const facts = this.requestFacts(request);
      if (status < 500) {
        const type = this.typeOf(error);
        this.logger.warn({ message: `Request refused ${status} ${type}`, obj: { status, type, ...facts } });
      } else {
        this.logger.error({
          message: 'Request failed',
          error,
          obj: { status, method: facts.method, path: facts.path },
        });
      }

      if (response.headersSent) {
        // The response is already on the wire: nothing can be answered. End the connection —
        // what was written flushes, then the close — so the client sees a truncated response
        // rather than a hang or a response that claims to be complete.
        response.socket?.end();
        return;
      }

      this.respond(response, status, error);
    };
  }

  private respond(response: express.Response, status: number, error: any) {
    for (const name of RequestErrorHandler.STAGED_REPRESENTATION_HEADERS) {
      response.removeHeader(name);
    }

    // The http-errors convention: a refusal may carry headers of its own (405 Allow, 401
    // WWW-Authenticate).
    if (error && typeof error.headers === 'object' && error.headers !== null) {
      for (const [name, value] of Object.entries(error.headers)) {
        response.setHeader(name, String(value));
      }
    }

    const message = error && error.expose && error.message ? String(error.message) : STATUS_CODES[status];
    response.status(status).json({ error: message });
  }

  /** The error's own status when it is a valid 4xx/5xx (`status`, else `statusCode`); 500 otherwise. */
  private statusOf(error: any): number {
    const status = error?.status ?? error?.statusCode;
    return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  }

  /** What refused the request: the error's `type` (raw-body, body-parser) or its class name (send). */
  private typeOf(error: any): string {
    if (typeof error?.type === 'string' && error.type) {
      return error.type;
    }

    return error?.name ? String(error.name) : 'Error';
  }

  private requestFacts(request: express.Request): RequestFacts {
    const facts: RequestFacts = {
      method: request.method,
      path: this.pathOf(request),
      userAgentFamily: RequestErrorHandler.userAgentFamily(request.headers['user-agent']),
    };
    const conditionalHeaders = this.conditionalHeaders(request);
    if (conditionalHeaders) {
      facts.conditionalHeaders = conditionalHeaders;
    }

    const contentLength = request.headers['content-length'];
    if (contentLength !== undefined) {
      facts.contentLength = Number(contentLength);
    }

    return facts;
  }

  /** `originalUrl`: the path as the client sent it, whatever mount the erroring layer sat under. */
  private pathOf(request: express.Request): string {
    const url = request.originalUrl || request.url || '';
    const queryStart = url.indexOf('?');
    return queryStart === -1 ? url : url.slice(0, queryStart);
  }

  private conditionalHeaders(request: express.Request): Record<string, string> | undefined {
    const present: Record<string, string> = {};
    for (const name of RequestErrorHandler.CONDITIONAL_HEADERS) {
      const value = request.headers[name];
      if (value !== undefined) {
        present[name] = String(value).slice(0, RequestErrorHandler.HEADER_VALUE_MAX_LENGTH);
      }
    }

    return Object.keys(present).length > 0 ? present : undefined;
  }

  /**
   * A coarse label for the client — which KIND of thing asked, never the raw string: a browser
   * family, a webview, a bot, or the product token of a non-browser client (curl, node-fetch…).
   */
  private static userAgentFamily(userAgent: string | string[] | undefined): string {
    if (!userAgent) {
      return 'none';
    }

    const value = String(userAgent).toLowerCase();
    for (const [family, pattern] of RequestErrorHandler.USER_AGENT_FAMILIES) {
      if (pattern.test(value)) {
        return family;
      }
    }

    // The leading product token names a non-browser client (curl, node-fetch, okhttp…); the
    // `Mozilla/5.0` every browser-shaped string opens with names nothing.
    const product = /^([a-z0-9._-]+)\//.exec(value);
    return product && product[1] !== 'mozilla' ? product[1] : 'other';
  }
}
