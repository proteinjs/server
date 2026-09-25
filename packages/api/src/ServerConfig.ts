import express from 'express';
import expressSession from 'express-session';
import serveStatic = require('serve-static');

type MakeMandatory<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

/**
 * An origin as a browser states one and as CSP's `frame-ancestors` takes one: `scheme://host`, a
 * port when not the scheme's default — never a path, a query, a fragment or a trailing slash.
 */
export type PageOrigin = `${'http' | 'https'}://${string}`;

/**
 * One allowed source of a `Permissions-Policy` feature: `self` (the page's own origin), `*` (every
 * origin) or one origin. An empty list denies the feature everywhere, the page included.
 */
export type PermissionsPolicySource = 'self' | '*' | PageOrigin;

export interface ServerConfig {
  /**
   * Runs:
   *   - after server config
   *   - after `after server config` startup tasks
   *   - before server start
   */
  onStartup?: () => Promise<void>;
  session: MakeMandatory<expressSession.SessionOptions, 'secret' | 'store'>;
  authenticate?: (username: string, password: string) => Promise<true | string>;
  /**
   * The deployment's one public origin (`https://app.example.com`): where a plain-http request is
   * redirected — `<origin><the request's path and query>`, never a Location built from the request's
   * own Host header (a header any client writes). Exactly an origin (a path, a query, a default port
   * or a trailing slash refuses to boot, naming the value). Unset, the redirect names the host the
   * request carried, as a process that declares no origin can only do; a deployment behind TLS
   * termination declares one.
   */
  origin?: PageOrigin;
  staticContent?: {
    staticContentDir?: string;
    staticOptions?: serveStatic.ServeStaticOptions;
    /** @deprecated use bundlesDir instead */
    bundlePaths?: string[];
    /** Dir containing bundles; relative from `staticContentDir`. */
    bundlesDir?: string;
    /**
     * Where the files under `bundlesDir` are served from when it is not this process: an
     * absolute http(s) URL with no query or fragment (a trailing slash is ignored). The page
     * still lists the bundles the release carries under `bundlesDir`, but names each one as
     * `<bundlesUrl>/<path under bundlesDir>` — `https://assets.example.com/bundles` +
     * `app.1a2b3c.js` → `https://assets.example.com/bundles/app.1a2b3c.js` — and loads it in CORS
     * mode (`crossorigin`), so the browser reports an error thrown inside a bundle in full; the
     * place must answer such a load with `Access-Control-Allow-Origin`. The server answers its own
     * `/static/<bundlesDir>/…` with a permanent redirect to the same place, so a page served
     * before the move, or a stale copy of one, still reaches its bundles. The usual seat: a
     * deployment that publishes every release's content-hashed bundles to a store behind a CDN
     * before it rolls out, so a page of any release finds its chunks whichever process serves
     * it. Unset: the bundles are served from `staticContentDir` by this process. Ignored in
     * development, where the in-process build serves them. A malformed value refuses the boot.
     */
    bundlesUrl?: string;
    /** Relative from `staticContentDir` */
    faviconPath?: string;
    /** Used for hot reloading of bundle assets */
    appEntryPath?: string;
  };
  /** enables webpack builds on server-side; otherwise will serve bundle from staticContent.bundlePaths (default prod behavior) */
  hotClientBuilds?: {
    nodeModulesPath: string;
    webpackConfigPath: string;
  };
  disableHotClientBuilds?: boolean;
  port?: number;
  /**
   * Graceful-shutdown tuning (the SIGTERM drain — see `GracefulShutdown` in @proteinjs/server).
   * On SIGTERM the server flips `/health-check` to 503, keeps accepting connections for
   * `drainDelayMs` so load balancers observe the failing readiness and de-register, then closes
   * the listener, waits for its holds (bounded by `turnDrainMs`), lets in-flight requests
   * complete (bounded by `drainTimeoutMs`), and exits 0.
   */
  shutdown?: {
    /**
     * How long after SIGTERM the listener keeps accepting new connections while `/health-check`
     * reports 503. This is the readiness-propagation window: refusing connections before the
     * load balancer has observed the failing check turns draining into user-facing errors.
     * Default: 5000; 0 when `DEVELOPMENT` is set (no LB in dev — the supervisor's restarts
     * should be fast).
     */
    drainDelayMs?: number;
    /**
     * Bound on waiting for in-flight requests after the listener closes; past it the remaining
     * connections are force-closed. The process exits 0 either way. Default: 30000.
     */
    drainTimeoutMs?: number;
    /**
     * Bound on waiting for the process's HOLDS after the listener closes (`GracefulShutdown.hold`
     * in @proteinjs/server): work that must not die with the process and that no connection
     * represents — the canonical holder is a chat turn whose client disconnected mid-turn (the
     * response detached, the model still writing, nothing persisted yet). Past the bound every
     * hold still outstanding is logged by label and abandoned; the drain then proceeds. The
     * deployment's termination grace must exceed `drainDelayMs + turnDrainMs + drainTimeoutMs`
     * (plus any preStop hook). Default: 240000 — a chat turn runs minutes.
     */
    turnDrainMs?: number;
  };
  /**
   * The security headers every response this server sends carries (`PageSecurityHeaders` in
   * @proteinjs/server — one owner, mounted ahead of every middleware and route, deciding by the
   * response's class as its headers flush). Without a declaration: every page refuses framing
   * (`Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`) unless its route
   * declares `frameable`; every page carries `Referrer-Policy: strict-origin-when-cross-origin`;
   * every response carries `X-Content-Type-Options: nosniff`. Each key below adds a header the
   * deployment decides on.
   */
  pages?: {
    /**
     * The origins allowed to frame a route that declares `frameable` (`Route.frameable`), beside the
     * page's own origin: `['https://www.example.com']`. Each entry is exactly an origin (a path, a
     * query, a default port or a trailing slash refuses to boot, naming the entry). A page whose route
     * does not declare `frameable` refuses every framer whatever this lists.
     */
    frameAncestors?: PageOrigin[];
    /**
     * `Strict-Transport-Security` on every response answered over https (the request's own scheme,
     * read behind `trust proxy` from the forwarded protocol — a browser ignores the header on plain
     * http, so none is sent there): `max-age=<maxAgeSeconds>`, `; includeSubDomains` when set, `;
     * preload` when set. A deployment declares it once every host under the origin's domain serves
     * TLS — `includeSubDomains` pins every subdomain for the whole max-age, and a browser that
     * recorded it refuses a plain-http subdomain outright.
     */
    strictTransportSecurity?: {
      /** How long a browser remembers to use https for the host: a year (31536000) is the floor the preload list takes. */
      maxAgeSeconds: number;
      includeSubDomains?: boolean;
      preload?: boolean;
    };
    /**
     * `Permissions-Policy` on every page: each feature (`camera`, `microphone`, `geolocation`, …) with
     * the sources allowed to use it — `['self']` for the page's own origin, `[]` to deny it everywhere
     * (the page and every frame in it). Written as `camera=(self), geolocation=()`. A feature the
     * product uses is allowed for `self`; a feature it never uses is denied, so a script that reaches
     * the page cannot turn it on.
     */
    permissionsPolicy?: Record<string, PermissionsPolicySource[]>;
    /**
     * `Content-Security-Policy` on every page: each directive (`default-src`, `script-src`, …) with its
     * sources as CSP writes them (`'self'`, `'unsafe-inline'`, `data:`, `https://cdn.example.com`).
     * `reportOnly: true` sends it as `Content-Security-Policy-Report-Only` — the browser reports what
     * the policy WOULD block and blocks nothing — the posture a new policy runs in until its reports
     * come back clean; `false` enforces it. Either way the server mounts `POST /csp-report` and names
     * it in the policy's `report-uri`, so every violation a browser sees lands in this process's log
     * as one WARN line (the directive, the blocked source's origin, the page's redacted url). The
     * framing directive is the route's (`frame-ancestors` here refuses to boot — `Route.frameable` is
     * the one declaration), and the framework's `frame-ancestors` header is sent beside this policy.
     */
    contentSecurityPolicy?: {
      reportOnly: boolean;
      directives: Record<string, string[]>;
    };
  };
  request?: {
    disableRequestLogging?: boolean;
    beforeRequest?: (request: express.Request, response: express.Response, next: express.NextFunction) => Promise<void>;
    afterRequest?: (request: express.Request, response: express.Response, next: express.NextFunction) => Promise<void>;
    timeoutMs?: number;
  };
}
