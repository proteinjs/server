import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { Logger, type Log, type DefaultLogWriter } from '@proteinjs/logger';
import { RequestErrorHandler } from '../src/RequestErrorHandler';

/**
 * Errors raised BEFORE a route runs — the body parser's `request aborted` (the sender hung up
 * mid-body), the static server's 412 on a conditional header that did not match, a route that
 * threw synchronously — had no handler in the framework: express's default printer wrote each
 * stack to stderr, and a structured-logging pipeline ingested an unstructured error carrying no
 * method, path or status. The handler answers with the status and a JSON body, logs a 4xx as a
 * WARNING that names the request's facts and a 5xx as an ERROR with the stack, and never lets
 * the printer run.
 */
type HandlerInternals = { logger: Logger };

const listen = (app: express.Express): Promise<http.Server> =>
  new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

const request = (
  port: number,
  options: http.RequestOptions,
  body?: string
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });

const waitFor = async (condition: () => boolean, ms = 3000): Promise<void> => {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('RequestErrorHandler — pre-route errors are answered and logged with the request, never printed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-error-handler-'));
  let server: http.Server;
  let port: number;
  let entries: Log[];
  let stderr: jest.SpyInstance;

  beforeAll(async () => {
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);');
    const app = express();
    app.use(bodyParser.json({ limit: '1mb' }));
    app.use('/static', express.static(dir));
    app.post('/service/x', (_req, res) => res.json({ ok: true }));
    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    const handler = new RequestErrorHandler();
    entries = [];
    (handler as unknown as HandlerInternals).logger = new Logger({
      name: 'Server',
      logWriter: { write: (log: Log) => entries.push(log) } as unknown as DefaultLogWriter,
    });
    app.use(handler.middleware());
    server = await listen(app);
    port = (server.address() as AddressInfo).port;
    stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    stderr.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    entries.length = 0;
    stderr.mockClear();
  });

  it('a conditional header the file does not satisfy: 412 answered, ONE warning naming status, class, method, path and the headers present — no stderr', async () => {
    const response = await request(port, {
      method: 'GET',
      path: '/static/app.js',
      headers: {
        'If-Unmodified-Since': 'Thu, 01 Jan 2015 00:00:00 GMT',
        'User-Agent': 'Mozilla/5.0 (X11) Firefox/128.0',
      },
    });
    expect(response.status).toBe(412);
    expect(JSON.parse(response.body)).toEqual({ error: 'Precondition Failed' });
    expect(entries).toHaveLength(1);
    expect(entries[0].logLevel).toBe('warn');
    expect(entries[0].message).toBe('Request refused 412 PreconditionFailedError');
    expect(entries[0].obj).toEqual({
      status: 412,
      type: 'PreconditionFailedError',
      method: 'GET',
      path: '/static/app.js',
      userAgentFamily: 'Firefox',
      conditionalHeaders: ['if-unmodified-since'],
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it('the sender hung up mid-body: request aborted is a warning with the declared length and the route — no stderr', async () => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/service/x?draft=1',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '100' },
    });
    req.on('error', () => undefined);
    req.write('{"a":"1234');
    setTimeout(() => req.destroy(), 50);
    await waitFor(() => entries.length > 0);
    expect(entries).toHaveLength(1);
    expect(entries[0].logLevel).toBe('warn');
    expect(entries[0].message).toBe('Request refused 400 request.aborted');
    expect(entries[0].obj).toEqual({
      status: 400,
      type: 'request.aborted',
      method: 'POST',
      path: '/service/x',
      userAgentFamily: 'unknown',
      conditionalHeaders: [],
      contentLength: 100,
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it('a route that threw is ours: 500 answered with the status text, ONE error entry carrying the error and the route — no stderr', async () => {
    const response = await request(port, { method: 'GET', path: '/boom' });
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: 'Internal Server Error' });
    expect(entries).toHaveLength(1);
    expect(entries[0].logLevel).toBe('error');
    expect(entries[0].message).toBe('Request failed 500');
    expect(entries[0].error?.message).toBe('kaboom');
    expect(entries[0].obj).toEqual({ status: 500, method: 'GET', path: '/boom' });
    expect(stderr).not.toHaveBeenCalled();
  });
});
