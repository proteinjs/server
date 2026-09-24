import express from 'express';
import { Loadable, SourceRepository } from '@proteinjs/reflection';

export interface Route extends Loadable {
  path: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Use http instead of https */
  useHttp?: boolean;
  /**
   * Keep this route's request body exactly as it arrived, beside the parsed body — for a route that
   * verifies a signature computed over the bytes (a webhook's). Read them with `RawBody.of(request)`.
   * Only a declaring route's requests keep them; the body limit and the parsed `request.body` are
   * the same as every route's.
   */
  rawBody?: boolean;
  onRequest: (request: express.Request, response: express.Response) => Promise<void>;
}

export const getRoutes = () => SourceRepository.get().objects<Route>('@proteinjs/server-api/Route');
