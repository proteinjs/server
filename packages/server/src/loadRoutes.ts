import express from 'express';
import crypto from 'crypto';
import {
  ServerConfig,
  Route,
  getRequestListeners,
  Session,
  SessionData,
  getSessionDataCaches,
} from '@proteinjs/server-api';
import { createReactApp } from './routes/reactApp';
import { Logger } from '@proteinjs/logger';
import { Request } from './Request';

const logger = new Logger({ name: 'Server' });
let requestCounter: number = 0;

export function loadRoutes(routes: Route[], server: express.Express, config: ServerConfig) {
  let starRoute: Route | null = null;
  const wildcardRoutes: Route[] = [];
  for (const route of routes) {
    logger.info({ message: `Loading route: ${route.path}` });
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

  if (starRoute) {
    server[starRoute.method](starRoute.path, wrapRoute(starRoute.onRequest.bind(starRoute), config));
  }
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
    server[reactApp.method](reactApp.path, wrapRoute(reactApp.onRequest.bind(reactApp), config));
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

    const requestNumber = ++requestCounter;
    const requestId = crypto.randomBytes(8).toString('hex');

    // Set metadata into request async-hook storage
    new Request().setMetadata({
      number: requestNumber,
      id: requestId,
      url: request.originalUrl,
    });
    const sessionData: SessionData = { sessionId: request.sessionID, user: request.user as string, data: {} };
    for (const sessionDataCache of getSessionDataCaches()) {
      sessionData.data[sessionDataCache.key] = await sessionDataCache.create(sessionData.sessionId, sessionData.user);
    }
    Session.setData(sessionData);

    if (shouldLogRequest(request, config)) {
      let message = `Started ${request.originalUrl}`;
      if (process.env.DEVELOPMENT) {
        message = `[#${requestNumber}] ${message}`;
      }
      logger.info({ message });
    }

    await runBeforeRequestListeners(request, response);

    setRequestTimeout(request, config, requestNumber);

    // Run route
    try {
      await route(request, response);
    } catch (error) {
      console.error(error);
    }
    response.locals['responseHandled'] = true;

    await runAfterRequestListeners(request, response);

    if (shouldLogRequest(request, config)) {
      let message = `Finished ${request.originalUrl}`;
      if (process.env.DEVELOPMENT) {
        message = `[#${requestNumber}] ${message}`;
      }
      logger.info({ message });
    }

    next();
  };
}

function shouldLogRequest(request: express.Request, config: ServerConfig) {
  if (config.request?.disableRequestLogging) {
    return false;
  }

  if (request.path.startsWith('/static') || request.path.startsWith('/favicon.ico')) {
    return false;
  }

  return true;
}

function setRequestTimeout(request: express.Request, config: ServerConfig, requestNumber: number) {
  const sixtyMinutes = 1000 * 60 * 60;
  const timeout = typeof config.request?.timeoutMs !== 'undefined' ? config.request.timeoutMs : sixtyMinutes;
  request.setTimeout(timeout, () => {
    let message = `Timed out ${request.originalUrl}`;
    if (process.env.DEVELOPMENT) {
      message = `[#${requestNumber}] ${message}`;
    }
    logger.warn({ message });
  });
}

async function runBeforeRequestListeners(request: express.Request, response: express.Response) {
  const requestListeners = getRequestListeners();
  for (const listener of requestListeners) {
    if (!listener.beforeRequest) {
      continue;
    }

    try {
      await listener.beforeRequest(request, response);
    } catch (error: any) {
      logger.error({ message: `Caught error when running listener before request`, error });
    }
  }
}

async function runAfterRequestListeners(request: express.Request, response: express.Response) {
  const requestListeners = getRequestListeners();
  for (const listener of requestListeners) {
    if (!listener.afterRequest) {
      continue;
    }

    try {
      await listener.afterRequest(request, response);
    } catch (error: any) {
      logger.error({ message: `Caught error when running listener after request`, error });
    }
  }
}
