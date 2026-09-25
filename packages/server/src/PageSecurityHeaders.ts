import express from 'express';
import bodyParser from 'body-parser';
import { ServerResponse } from 'http';
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
 * The server's one owner of the security headers a response carries — decided as the response's
 * headers flush, by the response's CLASS, never per page:
 *
 *  - EVERY response, documents included, carries `X-Content-Type-Options: nosniff`: a script or
 *    style served under another type is never sniffed into one, a JSON answer never rendered as a
 *    page. Every response answered over https carries `Strict-Transport-Security` when the
 *    deployment declares it (`ServerConfig.pages.strictTransportSecurity`): the browser then reaches
 *    this host over https alone for the declared time, whatever a link or a typed address says. A
 *    browser ignores the header on plain http (RFC 6797 §8.1), so none is sent there.
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
 *    from the log before the policy is enforced. Anyone can post to the door; it answers 204 and
 *    logs a bounded body, nothing more.
 *
 * Installed ahead of every middleware and route (`startServer`), so the framework's own answers
 * (the https redirect, express's 404, `express.static`) carry the same headers as a route's. A
 * policy a response already carries stays: ours is appended as a second policy in the one header
 * (CSP3 §3.1, a comma-separated policy list; §8.1, every one enforced). `X-Frame-Options` is this owner's
 * alone: the declaration is the route's `frameable`, never a header a page sets itself.
 */
export class PageSecurityHeaders {
  /** Where a browser posts a Content-Security-Policy violation report; named in every declared policy's `report-uri`. */
  static readonly CSP_REPORT_PATH = '/csp-report';
  private static readonly FRAMEABLE = 'pageSecurityHeaders.frameable';
  private static readonly REPORT_BODY_LIMIT = '16kb';
  private static readonly REPORT_BODY_TYPES = [
    'application/csp-report',
    'application/reports+json',
    'application/json',
  ];
  private static readonly NAME = /^[a-z][a-z0-9-]*$/;

  /** Mounts the owner on `app` ahead of everything else; a declaration the server cannot send as written refuses to boot. */
  static install(app: express.Express, config: ServerConfig): void {
    const policy = PageSecurityHeaders.policyOf(config);
    app.use((request: express.Request, response: express.Response, next: express.NextFunction) => {
      onHeaders(response, () => PageSecurityHeaders.stamp(request, response, policy));
      next();
    });
    if (policy.contentSecurityPolicy) {
      PageSecurityHeaders.installReportDoor(app);
    }
  }

  /** The route door's word for a route that declares `frameable`: this response may be framed. */
  static allowFraming(response: express.Response): void {
    response.locals[PageSecurityHeaders.FRAMEABLE] = true;
  }

  private static stamp(request: express.Request, response: express.Response, policy: Policy): void {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (policy.strictTransportSecurity && request.secure) {
      response.setHeader('Strict-Transport-Security', policy.strictTransportSecurity);
    }
    if (!PageSecurityHeaders.isDocument(response)) {
      return;
    }

    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (policy.permissionsPolicy) {
      response.setHeader('Permissions-Policy', policy.permissionsPolicy);
    }
    const frameable = response.locals[PageSecurityHeaders.FRAMEABLE] === true;
    const ancestors = frameable ? ["'self'", ...policy.frameAncestors] : ["'none'"];
    const framing = `frame-ancestors ${ancestors.join(' ')}`;
    const csp = policy.contentSecurityPolicy;
    if (csp && !csp.reportOnly) {
      PageSecurityHeaders.appendPolicy(response, 'Content-Security-Policy', `${framing}; ${csp.text}`);
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
   * log prints them (a page's query can carry a credential; a blocked source's can too).
   */
  private static installReportDoor(app: express.Express): void {
    const parse = bodyParser.json({
      type: PageSecurityHeaders.REPORT_BODY_TYPES,
      limit: PageSecurityHeaders.REPORT_BODY_LIMIT,
    });
    app.post(PageSecurityHeaders.CSP_REPORT_PATH, parse, (request: express.Request, response: express.Response) => {
      for (const violation of PageSecurityHeaders.violationsIn(request.body)) {
        logger.warn({ message: `Content Security Policy violation reported`, obj: violation });
      }
      response.status(204).end();
    });
  }

  /** Every violation a report body carries, in one shape, every url redacted; a body of another shape carries none. */
  private static violationsIn(body: unknown): Record<string, unknown>[] {
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
    return reports.map((report) => ({
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
    }));
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
