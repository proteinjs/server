import express from 'express';
import crypto from 'crypto';
import { AsyncResource } from 'async_hooks';
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
import { RedactedUrl } from './RedactedUrl';

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

/** A route's express path: its declared path, rooted. */
export function getPath(path: string) {
  return path.startsWith('/') ? path : `/${path}`;
}

function wrapRoute(
  route: (request: express.Request, response: express.Response) => Promise<void>,
  config: ServerConfig
) {
  const handleRequest = async function (
    request: express.Request,
    response: express.Response,
    next: express.NextFunction
  ) {
    const requestNumber = ++requestCounter;
    const requestId = crypto.randomBytes(8).toString('hex');
    // Every line below — and every line a log writer attaches the metadata to — prints this form:
    // the path and the query's keys, never a query value (a reset or invite link's credential) and
    // never a fragment's content.
    const loggedUrl = RedactedUrl.of(request.originalUrl);

    // Seed this request's OWN metadata into its scope. The scope inherits whatever lineage the
    // dispatch arrives in, and setMetadata is first-write-wins: a request dispatched from inside
    // another request's lineage (a middleware that holds a request and releases it from another
    // request's work) would keep that request's metadata. Clear the inherited entry first — the
    // scope's own, never the other request's (the same boundary as Session.clearData below).
    const requestMetadata = new Request();
    requestMetadata.clearMetadata();
    requestMetadata.setMetadata({
      number: requestNumber,
      id: requestId,
      url: loggedUrl,
    });
    const sessionData: SessionData = { sessionId: request.sessionID, user: request.user as string, data: {} };
    for (const sessionDataCache of getSessionDataCaches()) {
      sessionData.data[sessionDataCache.key] = await sessionDataCache.create(sessionData.sessionId, sessionData.user);
    }
    // A request always seeds ITS OWN session context: on a reused keep-alive socket this
    // dispatch is born inside the previous request's async lineage (the storage's init hook
    // copies bags onto descendants), and first-write-wins setData would silently drop this
    // request's seed — the request then runs (and server-renders proteinjs.sessionData) as
    // the PRIOR request's user (observed 2026-08-26: stale home greeting after a /dev/login
    // account switch; roster correct, greeting wrong). Clear the inherited entry first.
    Session.clearData();
    Session.setData(sessionData);

    if (shouldLogRequest(request, config)) {
      let message = `Started ${loggedUrl}`;
      if (process.env.DEVELOPMENT) {
        message = `[#${requestNumber}] ${message}`;
      }
      logger.info({ message });
    }

    await runBeforeRequestListeners(request, response);

    setRequestTimeout(request, config, requestNumber, loggedUrl);

    // Run route
    try {
      await route(request, response);
    } catch (error) {
      console.error(error);
    }
    response.locals['responseHandled'] = true;

    await runAfterRequestListeners(request, response);

    if (shouldLogRequest(request, config)) {
      let message = `Finished ${loggedUrl}`;
      if (process.env.DEVELOPMENT) {
        message = `[#${requestNumber}] ${message}`;
      }
      logger.info({ message });
    }

    next();
  };

  return function (request: express.Request, response: express.Response, next: express.NextFunction) {
    if (response.locals['responseHandled']) {
      next();
      return;
    }

    // Each routed request runs in its OWN async scope, so its metadata and session data land on
    // the scope, never on the async context the dispatch arrives in. Node dispatches every request
    // on a connection from that connection's one long-lived async resource: metadata written there
    // outlived its request, and on a reused keep-alive connection every later request read it as
    // its own — in the lines written before its route (the session store's read) and in socket.io's
    // polling requests, which never reach a route. In the scope, a line written before a request's
    // route carries no request's metadata, and never another request's.
    const requestScope = new AsyncResource('ROUTED_REQUEST', { requireManualDestroy: true });
    try {
      return requestScope.runInAsyncScope(handleRequest, null, request, response, next);
    } finally {
      // The scope's own entries go now; everything the request started holds its own copies.
      requestScope.emitDestroy();
    }
  };
}

/**
 * The readiness route (src/routes/healthCheck.ts). Polled continuously by whatever fronts the
 * process — a load balancer's health checker, a kubelet's readiness and liveness probes, every
 * couple of seconds per instance, forever — so its Started/Finished pair is paid log ingestion
 * carrying no signal. Compared exactly: a page whose path merely begins with it is a request.
 */
const HEALTH_CHECK_PATH = '/health-check';

function shouldLogRequest(request: express.Request, config: ServerConfig) {
  if (config.request?.disableRequestLogging) {
    return false;
  }

  if (request.path.startsWith('/static') || request.path.startsWith('/favicon.ico')) {
    return false;
  }

  if (request.path === HEALTH_CHECK_PATH) {
    return false;
  }

  return true;
}

function setRequestTimeout(request: express.Request, config: ServerConfig, requestNumber: number, loggedUrl: string) {
  const sixtyMinutes = 1000 * 60 * 60;
  const timeout = typeof config.request?.timeoutMs !== 'undefined' ? config.request.timeoutMs : sixtyMinutes;
  request.setTimeout(timeout, () => {
    let message = `Timed out ${loggedUrl}`;
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
