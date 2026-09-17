import express from 'express';
import { STATUS_CODES } from 'http';
import { Logger } from '@proteinjs/logger';

/** The shape http-errors, body-parser and `send` give the errors they hand to `next`. */
type HttpError = Error & { status?: number; statusCode?: number; type?: string; expose?: boolean };

/** The request headers that make a response conditional — named on a refusal, never carried. */
const CONDITIONAL_HEADERS = ['if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'range'];

/** The user-agent FAMILY a refusal names: a coarse product word, never the string itself. */
const USER_AGENT_FAMILIES: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/FxiOS\/|Firefox\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

/**
 * THE ONE HANDLER for errors raised before a route runs — the body parser's `request aborted`
 * (the sender hung up mid-body) and its `entity.too.large` / `entity.parse.failed`, the static
 * file server's 412 / 416 once a file was found (a conditional header the file did not satisfy),
 * any middleware or route that hands express an error. Without it express's default printer wrote
 * each stack to stderr, and a structured-logging pipeline ingested an unstructured error carrying
 * the process's name as its version and nothing about the request.
 *
 * A 4xx is the client's doing and logs at WARN with the request's facts — the status, the error's
 * type (body-parser's `type`, else the error's name), the method and path (query dropped), the
 * user-agent family, which conditional headers were present, the declared content length; a 5xx
 * is ours and logs at ERROR with the error and its stack. Either way the response is answered with
 * the status and a JSON body: the error's own message when it is safe to expose (http-errors'
 * `expose`), else the status text. Registered LAST, after every route; a response already in
 * flight is left to express (`headersSent`).
 */
export class RequestErrorHandler {
  private logger = new Logger({ name: 'Server' });

  middleware(): express.ErrorRequestHandler {
    // Four declared parameters: that arity is how express tells an error handler from a route.
    return (error: unknown, request: express.Request, response: express.Response, next: express.NextFunction) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      const httpError = this.asHttpError(error);
      const status = this.statusOf(httpError);
      const method = request.method;
      const path = request.originalUrl.split('?')[0];
      if (status < 500) {
        const type = httpError.type ?? httpError.name;
        const contentLength = Number(request.headers['content-length']);
        this.logger.warn({
          message: `Request refused ${status} ${type}`,
          obj: {
            status,
            type,
            method,
            path,
            userAgentFamily: this.userAgentFamily(request.headers['user-agent']),
            conditionalHeaders: CONDITIONAL_HEADERS.filter((header) => request.headers[header] !== undefined),
            ...(Number.isFinite(contentLength) ? { contentLength } : {}),
          },
        });
      } else {
        this.logger.error({ message: `Request failed ${status}`, error: httpError, obj: { status, method, path } });
      }
      const exposed = status < 500 && httpError.expose && httpError.message;
      response.status(status).send({ error: exposed ? httpError.message : STATUS_CODES[status] ?? 'Error' });
    };
  }

  private asHttpError(error: unknown): HttpError {
    return error instanceof Error ? (error as HttpError) : new Error(String(error));
  }

  private statusOf(error: HttpError): number {
    const status = Number(error.status ?? error.statusCode);
    return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  }

  private userAgentFamily(userAgent: string | undefined): string {
    if (!userAgent) {
      return 'unknown';
    }
    for (const [pattern, family] of USER_AGENT_FAMILIES) {
      if (pattern.test(userAgent)) {
        return family;
      }
    }
    // A non-browser client (a fetcher, a probe): its product token, never the whole string.
    return /^([A-Za-z][\w.-]*)\//.exec(userAgent)?.[1] ?? 'other';
  }
}
