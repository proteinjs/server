import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { SourceRepository } from '@proteinjs/reflection';
import type { Route, ServerConfig } from '@proteinjs/server-api';
import { loadRoutes } from '../src/loadRoutes';
import { NodeSessionDataStorage } from '../src/NodeSessionDataStorage';
import { Request } from '../src/Request';

/**
 * THE REQUEST'S OWN FACTS ride its metadata — the async-hooks bag every log line written inside
 * the request reads (`Request.getMetadata()`): beside the number, id and url, the HTTP method,
 * the requesting client's user agent, and the client's SELF-DECLARED CONTEXT — every
 * `x-client-*` header, keyed by its full name — so a log writer downstream names the route, the
 * device and the client build on every line without a second read of the express request.
 */
type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };
const seedLoadable = (qualifiedName: string, objects: unknown[]) => {
  (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache[qualifiedName] = objects;
};

const config = {
  session: { secret: 'test', store: undefined },
  request: { disableRequestLogging: true },
} as unknown as ServerConfig;

const get = (port: number, path: string, headers: Record<string, string>): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve(JSON.parse(text)));
    });
    req.on('error', reject);
    req.end();
  });

describe('request metadata — the facts every line of the request can name', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    seedLoadable('@proteinjs/server-api/SessionDataStorage', [new NodeSessionDataStorage()]);
    seedLoadable('@proteinjs/server-api/SessionDataCache', []);
    seedLoadable('@proteinjs/server-api/RequestListener', []);
    const app = express();
    const echo = {
      path: 'echo',
      method: 'get',
      onRequest: async (_request: express.Request, response: express.Response) => {
        response.json(new Request().getMetadata() ?? {});
      },
    } as unknown as Route;
    loadRoutes([echo], app, config);
    server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('carries the method, the user agent and every x-client-* header — and only those', async () => {
    const metadata = await get(port, '/echo?x=1', {
      'user-agent': 'TestAgent/1.0',
      'x-client-version': '1.27.0',
      'x-client-bundle': 'abc123',
      'x-other': 'never',
    });
    expect(metadata).toMatchObject({
      url: '/echo?x=1',
      method: 'GET',
      userAgent: 'TestAgent/1.0',
      clientContext: { 'x-client-version': '1.27.0', 'x-client-bundle': 'abc123' },
    });
    expect(metadata.clientContext).not.toHaveProperty('x-other');
    expect(typeof metadata.id).toBe('string');
    expect(typeof metadata.number).toBe('number');
  });

  it('a request that declared nothing carries no client context and no user agent — absent, never an empty bag', async () => {
    const metadata = await get(port, '/echo', {});
    expect(metadata.method).toBe('GET');
    expect(metadata).not.toHaveProperty('clientContext');
    expect(metadata).not.toHaveProperty('userAgent');
  });
});
