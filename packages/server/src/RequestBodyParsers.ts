import express from 'express';
import bodyParser from 'body-parser';
import { IncomingMessage, ServerResponse } from 'http';
import { RawBody, Route } from '@proteinjs/server-api';
import { getPath } from './loadRoutes';

/**
 * The server's one owner of request-body parsing: a JSON body and a form body, each up to
 * {@link BODY_LIMIT}, parsed onto `request.body` for every route.
 *
 * A route that declares `rawBody` also gets the body's exact bytes beside the parsed body
 * (`RawBody.of(request)`), for a signature computed over them (a webhook's). The same parsers keep
 * them — their `verify` hook hands over the buffer they already read — and only for a declaring
 * route's requests: never a second parser, never a copy of every request's bytes. A body over the
 * limit is refused exactly as for every route.
 */
export class RequestBodyParsers {
  private static readonly BODY_LIMIT = '100mb';
  /** The requests whose route declared `rawBody` — marked ahead of the parsers, read by their `verify`. */
  private static readonly rawBodyRequests = new WeakSet<IncomingMessage>();

  /** Mounts the parsers on `app` ahead of every route, each declaring route's mark ahead of them. */
  static install(app: express.Express, routes: Route[]) {
    for (const route of routes.filter((route) => route.rawBody)) {
      // Matched by express itself, on the route's own method and path — the match that dispatches it.
      app[route.method](getPath(route.path), (request, _response, next) => {
        RequestBodyParsers.rawBodyRequests.add(request);
        next();
      });
    }
    const verify = RequestBodyParsers.keepRawBody;
    app.use(bodyParser.json({ limit: RequestBodyParsers.BODY_LIMIT, verify }));
    app.use(bodyParser.urlencoded({ extended: true, limit: RequestBodyParsers.BODY_LIMIT, verify }));
  }

  /** The parsers' `verify` hook: the bytes they read, kept for a declaring route's request only. */
  private static keepRawBody(request: IncomingMessage, _response: ServerResponse, bytes: Buffer) {
    if (RequestBodyParsers.rawBodyRequests.has(request)) {
      RawBody.keep(request, bytes);
    }
  }
}
