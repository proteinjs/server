import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import express from 'express';
import bodyParser from 'body-parser';
import { Logger, Log, DefaultLogWriter } from '@proteinjs/logger';
import { RequestErrorHandler } from '../src/RequestErrorHandler';

/**
 * `RequestErrorHandler` on a real express pipeline, in process: the middlewares that raise the
 * errors are the real ones (express.static, body-parser), the logger is captured, and the
 * assertions are on what the handler WRITES (level, message, facts) and ANSWERS (status, body,
 * headers). The front-door suite (requestErrorPipeline.test.ts) then proves the same contract
 * through a served process — that the handler is registered last, where startServer wires it.
 */
const staticDir = path.join(__dirname, 'fixture', 'static');
const oldDate = 'Thu, 01 Jan 2015 00:00:00 GMT';

/** The private user-agent classifier, reached the way tests reach helpers: a typed cast, not a public method. */
type HandlerInternals = { userAgentFamily: (userAgent: string | undefined) => string };
const internals = RequestErrorHandler as unknown as HandlerInternals;

describe('RequestErrorHandler', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('a 412 from the static router: one WARN carrying the request facts, a JSON answer with the exposed message', async () => {
    harness = await startHarness((app) => app.use('/static', express.static(staticDir)));

    const served = await request(harness.port, { method: 'GET', path: '/static/asset.txt' });
    expect(served.status).toBe(200);
    expect(served.headers['etag']).toBeDefined();

    const result = await request(harness.port, {
      method: 'GET',
      path: '/static/asset.txt?v=held',
      headers: { 'User-Agent': 'curl/8.4.0', 'If-Unmodified-Since': oldDate },
    });
    expect(result.status).toBe(412);
    expect(result.headers['content-type']).toContain('application/json');
    expect(JSON.parse(result.body)).toEqual({ error: 'Precondition Failed' });
    // The static router stages the FILE's representation headers before it checks the
    // condition; the refusal describes the error, not the file (its own ETag is the answer's).
    expect(result.headers['etag']).not.toBe(served.headers['etag']);
    expect(result.headers['last-modified']).toBeUndefined();
    expect(result.headers['cache-control']).toBeUndefined();

    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]).toMatchObject({
      loggerName: 'Server',
      logLevel: 'warn',
      message: 'Request refused 412 PreconditionFailedError',
      obj: {
        status: 412,
        type: 'PreconditionFailedError',
        method: 'GET',
        path: '/static/asset.txt',
        userAgentFamily: 'curl',
        conditionalHeaders: { 'if-unmodified-since': oldDate },
      },
    });
    expect(harness.writes[0].obj.contentLength).toBeUndefined();
    expect(harness.writes[0].error).toBeUndefined();
  });

  it('a body the parser cannot read: 400 entity.parse.failed at WARN with the declared length; the parser message is exposed', async () => {
    harness = await startHarness((app) => app.use(bodyParser.json()));

    const result = await request(harness.port, {
      method: 'POST',
      path: '/service/x',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(result.status).toBe(400);
    const answer = JSON.parse(result.body);
    expect(typeof answer.error).toBe('string');
    expect(answer.error).not.toBe('Bad Request'); // body-parser exposes its own message

    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]).toMatchObject({
      logLevel: 'warn',
      message: 'Request refused 400 entity.parse.failed',
      obj: { status: 400, type: 'entity.parse.failed', method: 'POST', path: '/service/x', contentLength: 9 },
    });
    expect(harness.writes[0].obj.conditionalHeaders).toBeUndefined();
  });

  it('a failed request: one ERROR carrying the error itself; 500 with a generic body — the message never leaves the process', async () => {
    harness = await startHarness((app) =>
      app.get('/fail', (_request, _response, next) => next(new Error('secret detail')))
    );

    const result = await request(harness.port, { method: 'GET', path: '/fail?attempt=2' });
    expect(result.status).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: 'Internal Server Error' });
    expect(result.body).not.toContain('secret detail');

    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]).toMatchObject({
      loggerName: 'Server',
      logLevel: 'error',
      message: 'Request failed',
      obj: { status: 500, method: 'GET', path: '/fail' },
    });
    expect(harness.writes[0].error).toBeInstanceOf(Error);
    expect(harness.writes[0].error.message).toBe('secret detail');
  });

  it('a 5xx status on the error is kept (503 stays 503), still an ERROR with a generic body', async () => {
    harness = await startHarness((app) =>
      app.get('/down', (_request, _response, next) => next(Object.assign(new Error('pool exhausted'), { status: 503 })))
    );

    const result = await request(harness.port, { method: 'GET', path: '/down' });
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body)).toEqual({ error: 'Service Unavailable' });
    expect(harness.writes[0]).toMatchObject({ logLevel: 'error', obj: { status: 503 } });
  });

  it('a status outside 400–599 is not an HTTP error status: answered 500', async () => {
    harness = await startHarness((app) => {
      app.get('/ok-status', (_request, _response, next) => next(Object.assign(new Error('odd'), { status: 200 })));
      app.get('/text-status', (_request, _response, next) => next(Object.assign(new Error('odd'), { status: 'nope' })));
    });

    expect((await request(harness.port, { method: 'GET', path: '/ok-status' })).status).toBe(500);
    expect((await request(harness.port, { method: 'GET', path: '/text-status' })).status).toBe(500);
    expect(harness.writes.map((write) => write.logLevel)).toEqual(['error', 'error']);
  });

  it('a refusal keeps the headers it carries (405 Allow) and answers with its exposed message', async () => {
    harness = await startHarness((app) =>
      app.post('/read-only', (_request, _response, next) =>
        next(Object.assign(new Error('read-only resource'), { status: 405, expose: true, headers: { Allow: 'GET' } }))
      )
    );

    const result = await request(harness.port, { method: 'POST', path: '/read-only' });
    expect(result.status).toBe(405);
    expect(result.headers['allow']).toBe('GET');
    expect(JSON.parse(result.body)).toEqual({ error: 'read-only resource' });
    expect(harness.writes[0]).toMatchObject({ logLevel: 'warn', message: 'Request refused 405 Error' });
  });

  it('after headers are on the wire nothing can be answered: the line is still written, the connection is closed', async () => {
    harness = await startHarness((app) =>
      app.get('/half', (_request, response, next) => {
        response.write('partial');
        next(new Error('late failure'));
      })
    );

    const result = await request(harness.port, { method: 'GET', path: '/half' });
    expect(result.status).toBe(200); // the headers that were already sent
    expect(result.body).toBe('partial');
    expect(result.truncated).toBe(true);

    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]).toMatchObject({ logLevel: 'error', message: 'Request failed', obj: { path: '/half' } });
  });

  describe('the user-agent family', () => {
    it.each<[string | undefined, string]>([
      [undefined, 'none'],
      ['', 'none'],
      ['curl/8.4.0', 'curl'],
      ['node-fetch/1.0 (+https://github.com/bitinn/node-fetch)', 'node-fetch'],
      ['python-requests/2.31.0', 'python-requests'],
      ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'bot'],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
        'chrome',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 Edg/118.0.2088.46',
        'edge',
      ],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/118.0', 'firefox'],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'safari',
      ],
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/118.0.0.0 Mobile/15E148 Safari/604.1',
        'chrome',
      ],
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        'ios-webview',
      ],
      [
        'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 Mobile Safari/537.36',
        'android-webview',
      ],
      ['Mozilla/5.0 (X11; Linux x86_64)', 'other'],
    ])('%s → %s', (userAgent, family) => {
      expect(internals.userAgentFamily(userAgent)).toBe(family);
    });
  });
});

type Harness = { port: number; writes: Log[]; close: () => Promise<void> };

/** A real express app with the given layers, the handler registered last, the logger captured. */
async function startHarness(register: (app: express.Express) => void): Promise<Harness> {
  const writes: Log[] = [];
  const logWriter = { write: (log: Log) => writes.push(log) } as unknown as DefaultLogWriter;
  const app = express();
  register(app);
  app.use(new RequestErrorHandler(new Logger({ name: 'Server', logWriter })).middleware());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    writes,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** One request on its own connection; a connection dropped mid-response settles as `truncated`. */
function request(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method, path: options.path, agent: false, headers: options.headers },
      (res) => {
        let body = '';
        const settle = (truncated: boolean) =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers, truncated });
        res.on('data', (chunk) => (body += String(chunk)));
        res.on('end', () => settle(!res.complete));
        res.on('aborted', () => settle(true));
        res.on('error', () => settle(true));
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
