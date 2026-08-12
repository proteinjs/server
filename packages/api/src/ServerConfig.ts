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
   * the listener, lets in-flight requests complete (bounded by `drainTimeoutMs`), and exits 0.
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
     * connections are force-closed. The process exits 0 either way. The deployment's
     * termination grace must exceed `drainDelayMs + drainTimeoutMs`. Default: 30000.
     */
    drainTimeoutMs?: number;
  };
  request?: {
    disableRequestLogging?: boolean;
    beforeRequest?: (request: express.Request, response: express.Response, next: express.NextFunction) => Promise<void>;
    afterRequest?: (request: express.Request, response: express.Response, next: express.NextFunction) => Promise<void>;
    timeoutMs?: number;
  };
}
