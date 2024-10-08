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
  };
  disableHotClientBuilds?: boolean;
  port?: number;
  request?: {
    disableRequestLogging?: boolean;
    beforeRequest?: (request: express.Request, response: express.Response, next: express.NextFunction) => Promise<void>;
    afterRequest?: (request: express.Request, response: express.Response, next: express.NextFunction) => Promise<void>;
    timeoutMs?: number;
  };
}
