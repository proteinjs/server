import express from 'express';
import { Loadable, SourceRepository } from '@proteinjs/reflection';

export interface Route extends Loadable {
  path: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Use http instead of https */
  useHttp?: boolean;
  onRequest: (request: express.Request, response: express.Response) => Promise<void>;
}

export const getRoutes = () => SourceRepository.get().objects<Route>('@proteinjs/server-api/Route');
