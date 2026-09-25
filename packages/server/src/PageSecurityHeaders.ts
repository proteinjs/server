import express from 'express';
import { ServerResponse } from 'http';
import onHeaders from 'on-headers';
import { PageOrigin, ServerConfig } from '@proteinjs/server-api';

/**
 * The server's one owner of the security headers a response carries — decided as the response's
 * headers flush, by the response's CLASS, never per page:
 *
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
 *  - EVERY response, documents included, carries `X-Content-Type-Options: nosniff`: a script or
 *    style served under another type is never sniffed into one, a JSON answer never rendered as a
 *    page. JSON, an empty answer and file bytes carry no framing header — they render no UI to
 *    redress — and no referrer policy — they initiate no request of their own.
 *
 * Installed ahead of every middleware and route (`startServer`), so the framework's own answers
 * (the https redirect, express's 404, `express.static`) carry the same headers as a route's. A
 * policy a response already carries stays: ours is appended as a second policy in the one header
 * (CSP3 §3.1, a comma-separated policy list; §8.1, every one enforced). `X-Frame-Options` is this owner's
 * alone: the declaration is the route's `frameable`, never a header a page sets itself.
 */
export class PageSecurityHeaders {
  private static readonly FRAMEABLE = 'pageSecurityHeaders.frameable';

  /** Mounts the owner on `app` ahead of everything else; a listed entry that is not an origin refuses to boot. */
  static install(app: express.Express, config: ServerConfig): void {
    const frameAncestors = PageSecurityHeaders.originsOf(config.pages?.frameAncestors ?? []);
    app.use((request: express.Request, response: express.Response, next: express.NextFunction) => {
      onHeaders(response, () => PageSecurityHeaders.stamp(response, frameAncestors));
      next();
    });
  }

  /** The route door's word for a route that declares `frameable`: this response may be framed. */
  static allowFraming(response: express.Response): void {
    response.locals[PageSecurityHeaders.FRAMEABLE] = true;
  }

  private static stamp(response: express.Response, frameAncestors: string[]): void {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!PageSecurityHeaders.isDocument(response)) {
      return;
    }

    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    const frameable = response.locals[PageSecurityHeaders.FRAMEABLE] === true;
    const ancestors = frameable ? ["'self'", ...frameAncestors] : ["'none'"];
    PageSecurityHeaders.appendPolicy(response, `frame-ancestors ${ancestors.join(' ')}`);
    if (!frameable) {
      response.setHeader('X-Frame-Options', 'DENY');
    } else if (frameAncestors.length === 0) {
      response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    } else {
      response.removeHeader('X-Frame-Options');
    }
  }

  private static isDocument(response: ServerResponse): boolean {
    const contentType = response.getHeader('Content-Type');
    return typeof contentType === 'string' && /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(contentType);
  }

  private static appendPolicy(response: ServerResponse, policy: string): void {
    const existing = response.getHeader('Content-Security-Policy');
    const policies = Array.isArray(existing) ? existing : typeof existing === 'string' ? [existing] : [];
    response.setHeader('Content-Security-Policy', [...policies, policy].join(', '));
  }

  /**
   * Each listed entry exactly an origin (`scheme://host`, a port when not the scheme's default), or
   * a refusal naming the entry — the boot fails, never a `frame-ancestors` a browser would misread.
   */
  private static originsOf(entries: PageOrigin[]): string[] {
    return entries.map((entry) => {
      let origin: string | undefined;
      try {
        origin = new URL(entry).origin;
      } catch {
        origin = undefined;
      }
      if (origin !== entry) {
        throw new Error(
          `ServerConfig.pages.frameAncestors: ${JSON.stringify(entry)} is not an origin (scheme://host, a port when not the scheme's default — as CSP's frame-ancestors takes one)`
        );
      }
      return origin;
    });
  }
}
