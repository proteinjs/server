import express from 'express';
import expressSession from 'express-session';
import serveStatic = require('serve-static');

type MakeMandatory<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

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
  request?: {
    disableRequestLogging?: boolean;
    beforeRequest?: (request: express.Request, response: express.Response, next: express.NextFunction) => Promise<void>;
    afterRequest?: (request: express.Request, response: express.Response, next: express.NextFunction) => Promise<void>;
    timeoutMs?: number;
  };
}
