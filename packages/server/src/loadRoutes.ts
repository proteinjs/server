import express from 'express';
import passport from 'passport';
import {
  ServerConfig,
  Route,
  getRequestListeners,
  Session,
  SessionData,
  getSessionDataCaches,
} from '@proteinjs/server-api';
import { createReactApp } from './routes/reactApp';
import { Logger } from '@proteinjs/util';

const logger = new Logger('Server');

export function loadRoutes(routes: Route[], server: express.Express, config: ServerConfig) {
  let starRoute: Route | null = null;
  const wildcardRoutes: Route[] = [];
  for (const route of routes) {
    logger.info(`Loading route: ${route.path}`);
    if (route.path == '*') {
      starRoute = route;
      continue;
    }

    if (route.path.includes('*')) {
      wildcardRoutes.push(route);
      continue;
    }

    server[route.method](getPath(route.path), wrapRoute(route.onRequest.bind(route), config));
  }

  for (const wildcardRoute of wildcardRoutes) {
    server[wildcardRoute.method](
      getPath(wildcardRoute.path),
      wrapRoute(wildcardRoute.onRequest.bind(wildcardRoute), config)
    );
  }

  if (starRoute) server[starRoute.method](starRoute.path, wrapRoute(starRoute.onRequest.bind(starRoute), config));
}

export function loadDefaultStarRoute(routes: Route[], server: express.Express, config: ServerConfig) {
  let starRouteSpecified = false;
  for (const route of routes) {
    if (route.path == '*') {
      starRouteSpecified = true;
      break;
    }
  }

  if (!starRouteSpecified && (config.staticContent?.bundlePaths || config.staticContent?.bundlesDir)) {
    const reactApp = createReactApp(config);
    server[reactApp.method](reactApp.path, wrapRoute(reactApp.onRequest, config));
  }
}

function getPath(path: string) {
  return path.startsWith('/') ? path : `/${path}`;
}

function wrapRoute(
  route: (request: express.Request, response: express.Response) => Promise<void>,
  config: ServerConfig
) {
  return async function (request: express.Request, response: express.Response, next: express.NextFunction) {
    if (response.locals['responseHandled']) {
      next();
      return;
    }

    if (config.authenticate) {
      await new Promise<void>((resolve, reject) => {
        passport.authenticate('local', function (err, user, info) {
          if (err) reject(err);

          resolve();
        })(request, response, next);
      });
    }

    const sessionData: SessionData = { sessionId: request.sessionID, user: request.user as string, data: {} };
    for (const sessionDataCache of getSessionDataCaches())
      sessionData.data[sessionDataCache.key] = await sessionDataCache.create(sessionData.sessionId, sessionData.user);
    Session.setData(sessionData);

    const requestListeners = getRequestListeners();
    for (const listener of requestListeners) {
      if (!listener.beforeRequest) continue;

      try {
        await listener.beforeRequest(request, response);
      } catch (error: any) {
        logger.error(`Caught error when running listener before request`, error);
      }
    }

    const sixtyMinutes = 1000 * 60 * 60;
    const timeout = typeof config.request?.timeoutMs !== 'undefined' ? config.request.timeoutMs : sixtyMinutes;
    request.setTimeout(timeout, () => {
      if (response.locals.requestNumber)
        logger.warn(`[#${response.locals.requestNumber}] Timed out ${request.originalUrl}`);
      else logger.warn(`Timed out ${request.originalUrl}`);
    });

    try {
      await route(request, response);
    } catch (error) {
      console.error(error);
    }
    response.locals['responseHandled'] = true;

    for (const listener of requestListeners) {
      if (!listener.afterRequest) continue;

      try {
        await listener.afterRequest(request, response);
      } catch (error: any) {
        logger.error(`Caught error when running listener after request`, error);
      }
    }

    next();
  };
}

function basicAuthCredentials(request: express.Request): { username: string; password: string } | null {
  const b64auth = (request.headers.authorization || '').split(' ')[1] || '';
  const [username, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  if (!username || !password) return null;

  return { username, password };
}
