import express from 'express';
import bodyParser from 'body-parser';
import { IncomingMessage, Server as HttpServer, ServerResponse } from 'http';
import type { TLSSocket } from 'tls';
import onHeaders from 'on-headers';
import { Logger } from '@proteinjs/logger';
import { PageOrigin, PermissionsPolicySource, ServerConfig } from '@proteinjs/server-api';
import { DeclaredOrigin } from './DeclaredOrigin';
import { RedactedUrl } from './RedactedUrl';

const logger = new Logger({ name: 'PageSecurityHeaders' });

/** The deployment's declarations (`ServerConfig.pages`), read and checked once at boot, as the header values they become. */
type Policy = {
  frameAncestors: string[];
  strictTransportSecurity?: string;
  permissionsPolicy?: string;
  contentSecurityPolicy?: { reportOnly: boolean; text: string };
};

/**
 * The socket transport's hook for the headers its answers carry: engine.io's `headers` event, fired
 * with the headers object before each long-polling answer is written and — forwarded from ws's own
 * `headers` event — before the WebSocket upgrade's 101 is written on the raw socket.
 */
export type SocketTransportHeaders = {
  on(
    event: 'headers',
    listener: (headers: Record<string, string | string[]>, request: IncomingMessage) => void
  ): unknown;
};

/**
 * What `cover` stands on: the http server (every answer it hands a request listener), the express
 * app (its `trust proxy` setting says whether a forwarded protocol is believed) and the socket
 * transport (an accepted upgrade's 101, which is no response object).
 */
export type ResponseSeams = {
  server: HttpServer;
  app: express.Express;
  socketTransport: SocketTransportHeaders;
};

/**
 * The server's one owner of the security headers a response carries — decided as the response's
 * headers flush, by the response's CLASS, never per page:
 *
 *  - EVERY response this owner covers (the two sets are said below), documents included, carries
 *    `X-Content-Type-Options: nosniff`: a script or style served under another type is never
 *    sniffed into one, a JSON answer never rendered as a page. Each one answered over https carries
 *    `Strict-Transport-Security` when the deployment declares it
 *    (`ServerConfig.pages.strictTransportSecurity`): the browser then reaches this host over https
 *    alone for the declared time, whatever a link or a typed address says. A browser ignores the
 *    header on plain http (RFC 6797 §8.1), so none is sent there.
 *  - A DOCUMENT (`text/html`, `application/xhtml+xml`: the SPA shell, a consumer route's page,
 *    express's own error page, a redirect's body) REFUSES FRAMING — `Content-Security-Policy:
 *    frame-ancestors 'none'` and `X-Frame-Options: DENY`. The clickjacking shape: a page framed
 *    invisibly over a decoy, the visitor's click landing on the page's own controls. A route that
 *    declares `frameable` (`Route.frameable`) is framed by its own origin and the origins the
 *    deployment lists (`ServerConfig.pages.frameAncestors`): `frame-ancestors 'self' <origins>`.
 *    Precedence: a browser that reads `frame-ancestors` ignores `X-Frame-Options` (CSP3 §6.4.2.2);
 *    `X-Frame-Options` is for the browsers that do not, and it has only DENY and
 *    SAMEORIGIN (ALLOW-FROM died with the browsers that read it) — so a frameable page carries
 *    SAMEORIGIN when the deployment lists no origin, and no `X-Frame-Options` at all when it does,
 *    rather than refuse the framer the deployment allowed on exactly the browsers the header is for.
 *    THE FRAMING REFUSAL IS ALWAYS ENFORCED, never report-only — so a page the app frames from its
 *    OWN origin (an `<iframe src="/…">` of a route that does not declare `frameable`) is a blank
 *    frame, and the report-only run of a declared policy says nothing about it: the framing
 *    directive is never part of that policy, so a clean report-only run proves nothing about
 *    same-origin framing. Whenever the report door is mounted (a policy is declared, report-only or
 *    enforced) the refusal therefore names the door too, so a browser that refused to frame a page
 *    posts the violation and the break is one WARN line in the log rather than silent; with no
 *    policy declared there is no door and the break IS silent. A route the app means to frame
 *    declares `frameable`.
 *    A document also carries `Referrer-Policy: strict-origin-when-cross-origin`: its outbound
 *    cross-origin requests send the origin only — never a path carrying a reset or invite token.
 *    When the deployment declares them, a document carries `Permissions-Policy` (which browser
 *    features the page and its frames may use) and the deployment's `Content-Security-Policy` —
 *    enforced in the framing header's own policy, or as `Content-Security-Policy-Report-Only`
 *    while the policy is proven: the browser blocks nothing and reports what it would have.
 *    JSON, an empty answer and file bytes carry none of these — they render no UI to redress, run
 *    no script, initiate no request of their own.
 *  - A declared Content-Security-Policy names `report-uri /csp-report`, and this owner answers that
 *    door: a browser's violation report (either report format) becomes one WARN line — the
 *    directive, the blocked source's origin, the page's redacted url — so a report-only run is read
 *    from the log before the policy is enforced. Anyone can post to the door, so what one post can
 *    write is bounded: the door's own parser reads a body of at most 16 kB, at most twenty of its
 *    violations are logged — every field of a line cut to a fixed length — and one more line says
 *    how many were not. It answers 204, nothing more.
 *
 * MOUNTED ON THE HTTP SERVER ITSELF (`cover`). Which answers that reaches is said by construction,
 * in two sets, so the claim is never one path short:
 *
 * COVERED — every answer written through a response object the http server hands its request
 * listeners (node's `request` event), because this owner is the first of those listeners:
 *  - express's own: a route's, the https redirect, express's 404 and error pages, `express.static`'s
 *    bytes;
 *  - the answers no express middleware ever sees, because socket.io and its transport take their own
 *    path off the server AHEAD of the app: engine.io's long-polling answers and its refusals of a
 *    polling request, and the client script socket.io serves;
 * and the 101 of an ACCEPTED WebSocket upgrade — no response object: ws writes it on the raw socket,
 * and the transport's `headers` hook carries `X-Content-Type-Options` and `Strict-Transport-Security`
 * onto it.
 *
 * OUTSIDE BY CONSTRUCTION — an answer a library writes by itself, with no `request` event and no
 * hook: no listener is handed anything to stamp, and none of these carries a header of ours. Each
 * is a fixed status line with a fixed body or none, and echoes nothing of the request. Read in the
 * installed sources (node 22, engine.io 6.5.5, ws 8.17.1):
 *  - node's http server, straight onto the raw socket, to a request it cannot read, too large or too
 *    slow: a bare 400, 431 (the headers past their limit), 413 (a chunk's extensions past theirs)
 *    and 408 (`headersTimeout`, `requestTimeout`) — lib/_http_server.js `socketOnError`, taken only
 *    when nothing listens for `clientError`;
 *  - node's http server, through a response of its own that it hands no listener
 *    (lib/_http_server.js `parserOnIncoming`): a 400 to an HTTP/1.1 request with no Host header, a
 *    417 to an `Expect` it does not know (taken only when nothing listens for `checkExpectation`),
 *    the interim `100 Continue` ahead of an answer that IS covered, and a 503 past
 *    `maxRequestsPerSocket`, which this server never sets;
 *  - engine.io's refused upgrade (an unknown transport or session id, a bad handshake): a 400 with
 *    one of its own fixed messages — build/server.js `abortUpgrade` (its `allowRequest` option, the
 *    one seam that would put a consumer's words in that body, is not set);
 *  - ws's refused handshake (a method, an Upgrade, a Sec-WebSocket-Key, -Version, -Protocol or
 *    -Extensions header it does not take): a 405 or 400 with its own fixed message, and a 503 once
 *    it is closing — lib/websocket-server.js `abortHandshake`.
 * An upgrade on any other path is closed by engine.io with no answer at all. No wrapper stands on a
 * raw socket's write and no `clientError` or `checkExpectation` handler is registered: rewriting
 * bytes another library writes, for answers whose bodies are fixed strings, buys nothing. A library
 * bump that adds an answer of this kind adds it to this list.
 *
 * A policy a response already carries stays: ours is appended as a second policy in the one header
 * (CSP3 §3.1, a comma-separated policy list; §8.1, every one enforced). `X-Frame-Options` is this
 * owner's alone: the declaration is the route's `frameable`, never a header a page sets itself.
 */
export class PageSecurityHeaders {
  /** Where a browser posts a Content-Security-Policy violation report; named in every declared policy's `report-uri`. */
  static readonly CSP_REPORT_PATH = '/csp-report';
  private static readonly FRAMEABLE = 'pageSecurityHeaders.frameable';
  private static readonly REPORT_BODY_LIMIT = '16kb';
  /** The most violations of one report body that are logged; the rest are counted in one more line. */
  private static readonly REPORT_VIOLATIONS_LOGGED = 20;
  private static readonly REPORT_BODY_TYPES = [
    'application/csp-report',
    'application/reports+json',
    'application/json',
  ];
  private static readonly NAME = /^[a-z][a-z0-9-]*$/;

  private readonly policy: Policy;

  /** Reads the deployment's declarations (`ServerConfig.pages`); one the server cannot send as written refuses to boot here, naming it. */
  constructor(config: ServerConfig) {
    this.policy = PageSecurityHeaders.policyOf(config);
  }

  /**
   * Mounts the report door when a policy is declared. Called FIRST in the express chain, ahead of
   * the body parsers, the session and every route: a report is read by this door's own bounded
   * parser and costs no session read — anyone can post one.
   */
  openReportDoor(app: express.Express): void {
    if (this.policy.contentSecurityPolicy) {
      PageSecurityHeaders.installReportDoor(app);
    }
  }

  /**
   * Puts the headers on every answer of the covered set (the class comment says both sets). Called
   * AFTER the socket transport attached to the server:
   * socket.io and engine.io each take the server's request listeners for themselves as they attach
   * and call them only off their own paths, so a listener registered before them never sees a
   * socket request. Registered after them and FIRST in the server's list (`prependListener`): their
   * listener runs the transport's handler or express's inside itself, and either can answer in the
   * same turn (the transport's refusals; an express answer written at once), so a hook added behind
   * that listener arrives after those headers were written.
   */
  cover(seams: ResponseSeams): void {
    const { server, app, socketTransport } = seams;
    const policy = this.policy;
    server.prependListener('request', (request: IncomingMessage, response: ServerResponse) => {
      onHeaders(response, () => PageSecurityHeaders.stamp(request, response, app, policy));
    });
    socketTransport.on('headers', (headers, request) => {
      // A long-polling answer is an http response, stamped above; the upgrade's 101 is not.
      if (String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
        return;
      }
      headers['X-Content-Type-Options'] = 'nosniff';
      if (policy.strictTransportSecurity && PageSecurityHeaders.isSecure(request, app)) {
        headers['Strict-Transport-Security'] = policy.strictTransportSecurity;
      }
    });
  }

  /** The route door's word for a route that declares `frameable`: this response may be framed. */
  static allowFraming(response: express.Response): void {
    response.locals[PageSecurityHeaders.FRAMEABLE] = true;
  }

  private static stamp(request: IncomingMessage, response: ServerResponse, app: express.Express, policy: Policy): void {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (policy.strictTransportSecurity && PageSecurityHeaders.isSecure(request, app)) {
      response.setHeader('Strict-Transport-Security', policy.strictTransportSecurity);
    }
    if (!PageSecurityHeaders.isDocument(response)) {
      return;
    }

    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (policy.permissionsPolicy) {
      response.setHeader('Permissions-Policy', policy.permissionsPolicy);
    }
    // The route door's word rides express's `locals`; a response express never handled has none.
    const frameable = (response as Partial<express.Response>).locals?.[PageSecurityHeaders.FRAMEABLE] === true;
    const ancestors = frameable ? ["'self'", ...policy.frameAncestors] : ["'none'"];
    const framing = `frame-ancestors ${ancestors.join(' ')}`;
    const csp = policy.contentSecurityPolicy;
    if (csp && !csp.reportOnly) {
      PageSecurityHeaders.appendPolicy(response, 'Content-Security-Policy', `${framing}; ${csp.text}`);
    } else if (csp) {
      // The refusal is enforced while the declared policy is only reported: it names the door too,
      // so a page the app frames that this refuses is a WARN line, never a silent blank frame.
      PageSecurityHeaders.appendPolicy(
        response,
        'Content-Security-Policy',
        `${framing}; report-uri ${PageSecurityHeaders.CSP_REPORT_PATH}`
      );
    } else {
      PageSecurityHeaders.appendPolicy(response, 'Content-Security-Policy', framing);
    }
    if (csp && csp.reportOnly) {
      PageSecurityHeaders.appendPolicy(response, 'Content-Security-Policy-Report-Only', csp.text);
    }
    if (!frameable) {
      response.setHeader('X-Frame-Options', 'DENY');
    } else if (policy.frameAncestors.length === 0) {
      response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    } else {
      response.removeHeader('X-Frame-Options');
    }
  }

  /**
   * Whether the request came over https, read the way express reads `request.secure`: the
   * connection's own encryption, or — when the app trusts the proxy in front of it (`trust proxy`,
   * the load-balancer topology) — the first forwarded protocol. Read here for every request, since
   * the socket transport's requests never pass express and carry no `secure` of their own.
   */
  private static isSecure(request: IncomingMessage, app: express.Express): boolean {
    const encrypted = (request.socket as TLSSocket).encrypted === true;
    const trust = app.get('trust proxy fn') as (address: string | undefined, hop: number) => boolean;
    if (!trust(request.socket.remoteAddress, 0)) {
      return encrypted;
    }
    const forwarded = request.headers['x-forwarded-proto'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded ?? '').split(',')[0].trim();
    return first ? first === 'https' : encrypted;
  }

  private static isDocument(response: ServerResponse): boolean {
    const contentType = response.getHeader('Content-Type');
    return typeof contentType === 'string' && /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(contentType);
  }

  private static appendPolicy(response: ServerResponse, header: string, policy: string): void {
    const existing = response.getHeader(header);
    const policies = Array.isArray(existing) ? existing : typeof existing === 'string' ? [existing] : [];
    response.setHeader(header, [...policies, policy].join(', '));
  }

  /**
   * The report door: a browser's violation report, in the `report-uri` shape (`{ "csp-report": {…} }`,
   * sent as application/csp-report) or the Reporting API's (an array of `{ type, url, body }`), read
   * from a bounded body and written as one WARN line per violation — urls redacted the way the request
   * log prints them (a page's query can carry a credential; a blocked source's can too). One body is
   * logged for at most `REPORT_VIOLATIONS_LOGGED` violations and one more line counting the rest: a
   * body within the size limit can still hold hundreds of empty entries, and the door is open to anyone.
   */
  private static installReportDoor(app: express.Express): void {
    const parse = bodyParser.json({
      type: PageSecurityHeaders.REPORT_BODY_TYPES,
      limit: PageSecurityHeaders.REPORT_BODY_LIMIT,
    });
    app.post(PageSecurityHeaders.CSP_REPORT_PATH, parse, (request: express.Request, response: express.Response) => {
      const reports = PageSecurityHeaders.reportsIn(request.body);
      const logged = reports.slice(0, PageSecurityHeaders.REPORT_VIOLATIONS_LOGGED);
      for (const report of logged) {
        logger.warn({
          message: `Content Security Policy violation reported`,
          obj: PageSecurityHeaders.violationOf(report),
        });
      }
      if (reports.length > logged.length) {
        logger.warn({
          message: `Content Security Policy violations not logged: one report body carried more than ${logged.length}`,
          obj: { notLogged: reports.length - logged.length },
        });
      }
      response.status(204).end();
    });
  }

  /** Every violation a report body carries, as the browser sent it; a body of another shape carries none. */
  private static reportsIn(body: unknown): Record<string, unknown>[] {
    const reports: Record<string, unknown>[] = [];
    if (Array.isArray(body)) {
      for (const entry of body) {
        if (entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'csp-violation') {
          const inner = (entry as Record<string, unknown>).body;
          reports.push(inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : {});
        }
      }
    } else if (body && typeof body === 'object' && 'csp-report' in (body as Record<string, unknown>)) {
      const inner = (body as Record<string, unknown>)['csp-report'];
      reports.push(inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : {});
    }
    return reports;
  }

  /** One violation as its log line carries it: the two report shapes in one, every url redacted, every field cut to a fixed length. */
  private static violationOf(report: Record<string, unknown>): Record<string, unknown> {
    return {
      documentUrl: PageSecurityHeaders.redacted(report['document-uri'] ?? report.documentURL),
      violatedDirective: PageSecurityHeaders.word(report['violated-directive'] ?? report.effectiveDirective),
      effectiveDirective: PageSecurityHeaders.word(report['effective-directive'] ?? report.effectiveDirective),
      blockedUrl: PageSecurityHeaders.redacted(report['blocked-uri'] ?? report.blockedURL),
      disposition: PageSecurityHeaders.word(report.disposition),
      sourceFile: PageSecurityHeaders.redacted(report['source-file'] ?? report.sourceFile),
      lineNumber:
        typeof (report['line-number'] ?? report.lineNumber) === 'number'
          ? report['line-number'] ?? report.lineNumber
          : undefined,
    };
  }

  private static redacted(value: unknown): string | undefined {
    return typeof value === 'string' ? RedactedUrl.of(value).slice(0, 512) : undefined;
  }

  private static word(value: unknown): string | undefined {
    return typeof value === 'string' ? value.slice(0, 128) : undefined;
  }

  /** `ServerConfig.pages` as the header values it becomes; a declaration this owner cannot send as written refuses to boot, naming it. */
  private static policyOf(config: ServerConfig): Policy {
    const pages = config.pages ?? {};
    return {
      frameAncestors: PageSecurityHeaders.originsOf(pages.frameAncestors ?? []),
      strictTransportSecurity: pages.strictTransportSecurity
        ? PageSecurityHeaders.strictTransportSecurityOf(pages.strictTransportSecurity)
        : undefined,
      permissionsPolicy: pages.permissionsPolicy
        ? PageSecurityHeaders.permissionsPolicyOf(pages.permissionsPolicy)
        : undefined,
      contentSecurityPolicy: pages.contentSecurityPolicy
        ? {
            reportOnly: pages.contentSecurityPolicy.reportOnly,
            text: PageSecurityHeaders.contentSecurityPolicyOf(pages.contentSecurityPolicy.directives),
          }
        : undefined,
    };
  }

  /** Each listed entry exactly an origin, or a refusal naming the entry. */
  private static originsOf(entries: PageOrigin[]): string[] {
    return entries.map((entry) => DeclaredOrigin.of(entry, 'ServerConfig.pages.frameAncestors'));
  }

  private static strictTransportSecurityOf(
    declared: NonNullable<NonNullable<ServerConfig['pages']>['strictTransportSecurity']>
  ): string {
    if (!Number.isInteger(declared.maxAgeSeconds) || declared.maxAgeSeconds < 0) {
      throw new Error(
        `ServerConfig.pages.strictTransportSecurity.maxAgeSeconds: ${JSON.stringify(declared.maxAgeSeconds)} is not a whole number of seconds`
      );
    }
    const parts = [`max-age=${declared.maxAgeSeconds}`];
    if (declared.includeSubDomains) {
      parts.push('includeSubDomains');
    }
    if (declared.preload) {
      parts.push('preload');
    }
    return parts.join('; ');
  }

  /** `feature=(source source)` per feature, an origin quoted as the header takes it, an empty list as `()`. */
  private static permissionsPolicyOf(declared: Record<string, PermissionsPolicySource[]>): string {
    return Object.entries(declared)
      .map(([feature, sources]) => {
        if (!PageSecurityHeaders.NAME.test(feature)) {
          throw new Error(`ServerConfig.pages.permissionsPolicy: ${JSON.stringify(feature)} is not a feature name`);
        }
        const allowed = sources.map((source) =>
          source === 'self' || source === '*'
            ? source
            : `"${DeclaredOrigin.of(source, `ServerConfig.pages.permissionsPolicy.${feature}`)}"`
        );
        return `${feature}=(${allowed.join(' ')})`;
      })
      .join(', ');
  }

  /**
   * The declared directives as one policy, this owner's `report-uri` last. The framing directive is
   * the route's declaration and the reporting directives are this owner's: a policy that names them
   * refuses to boot, as does a source that would split the policy (a `;` or `,` inside one).
   */
  private static contentSecurityPolicyOf(directives: Record<string, string[]>): string {
    const lines = Object.entries(directives).map(([directive, sources]) => {
      if (!PageSecurityHeaders.NAME.test(directive)) {
        throw new Error(
          `ServerConfig.pages.contentSecurityPolicy: ${JSON.stringify(directive)} is not a directive name`
        );
      }
      if (directive === 'frame-ancestors') {
        throw new Error(
          `ServerConfig.pages.contentSecurityPolicy: frame-ancestors is the route's declaration (Route.frameable, with ServerConfig.pages.frameAncestors) — never a directive here`
        );
      }
      if (directive === 'report-uri' || directive === 'report-to') {
        throw new Error(
          `ServerConfig.pages.contentSecurityPolicy: ${directive} is the server's (every declared policy reports to ${PageSecurityHeaders.CSP_REPORT_PATH}) — never a directive here`
        );
      }
      for (const source of sources) {
        if (!/^\S+$/.test(source) || /[;,]/.test(source)) {
          throw new Error(
            `ServerConfig.pages.contentSecurityPolicy.${directive}: ${JSON.stringify(source)} is not one source (a source has no spaces, semicolons or commas)`
          );
        }
      }
      return sources.length > 0 ? `${directive} ${sources.join(' ')}` : directive;
    });
    return [...lines, `report-uri ${PageSecurityHeaders.CSP_REPORT_PATH}`].join('; ');
  }
}
