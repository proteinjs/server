import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * Request-error contract of a real server process (spawns the built dist — run `npm run build`
 * first), asserted through the front door: every error a middleware hands to `next(error)` —
 * before any route runs — is answered and logged by the framework's own handler, never by
 * express's default one.
 *
 * THE CLASS THIS PINS: the middlewares that run ahead of a route (static serving, body parsing)
 * raise errors of their own, and the pipeline registered no handler for them. Express 4's default
 * handler then prints `err.stack` to stderr and answers with an HTML page carrying the stack — so
 * a process log (or an error tracker fed by stderr) shows a bare `PreconditionFailedError` (a
 * client revalidating a file it held, under an `If-Unmodified-Since` the replaced file cannot
 * satisfy) or `BadRequestError: request aborted` (the sender hung up mid-body) with no route, no
 * method, no headers: nothing that says which client asked for what. A REFUSED request (4xx) is
 * one WARN line carrying those facts; a FAILED request (5xx) is one ERROR line carrying the error
 * itself; both answer with the status and a small JSON body, never a stack.
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');

/** The signature of express's default handler: `err.stack` printed raw — frames from the module
 *  that raised the error. The framework's own log lines never carry these. */
const SEND_STACK_FRAME = /send[\\/]index\.js/;
const RAW_BODY_STACK_FRAME = /raw-body[\\/]index\.js/;

describe('request errors through the front door', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
  });

  it('a conditional GET the file cannot satisfy is refused 412 and logged as a WARN with the request facts — no raw stack', async () => {
    fixture = await startFixture();

    const result = await request(fixture.port, {
      method: 'GET',
      path: '/static/asset.txt?v=held',
      headers: {
        'X-Forwarded-Proto': 'https',
        'User-Agent': 'curl/8.4.0',
        // A client that still holds the file as it was long ago: the file on disk is newer, so
        // the condition fails (RFC 9110 §13.1.4) — the HTTP-correct answer is 412.
        'If-Unmodified-Since': 'Thu, 01 Jan 2015 00:00:00 GMT',
      },
    });
    expect(result.status).toBe(412);
    expect(result.headers['content-type']).toContain('application/json');
    expect(JSON.parse(result.body)).toEqual({ error: 'Precondition Failed' });

    await fixture.waitForOutput((output) => output.includes('Request refused 412'), 3000);
    const output = fixture.output();
    expect(output).toContain('[Server] Request refused 412 PreconditionFailedError');
    expect(output).not.toContain('PreconditionFailedError: Precondition Failed'); // the stack's first line
    expect(output).toContain("method: 'GET'");
    expect(output).toContain("path: '/static/asset.txt'"); // the query stripped
    expect(output).toContain("userAgentFamily: 'curl'");
    expect(output).toContain("'if-unmodified-since': 'Thu, 01 Jan 2015 00:00:00 GMT'");
    expect(output).not.toMatch(SEND_STACK_FRAME);
  }, 30000);

  it('a sender hanging up mid-body is refused 400 request.aborted at WARN — no raw stack', async () => {
    fixture = await startFixture();

    await abortMidBody(fixture.port, '/service/x', 100, 10);

    await fixture.waitForOutput((output) => output.includes('Request refused 400'), 3000);
    const output = fixture.output();
    expect(output).toContain('[Server] Request refused 400 request.aborted');
    expect(output).toContain("method: 'POST'");
    expect(output).toContain("path: '/service/x'");
    expect(output).toContain('contentLength: 100');
    expect(output).not.toMatch(RAW_BODY_STACK_FRAME);
  }, 30000);

  it('an error a middleware hands to next() is answered 500 with a generic body and logged as an ERROR carrying the error', async () => {
    fixture = await startFixture();

    const result = await request(fixture.port, {
      method: 'GET',
      path: '/fail',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    expect(result.status).toBe(500);
    expect(result.headers['content-type']).toContain('application/json');
    expect(JSON.parse(result.body)).toEqual({ error: 'Internal Server Error' });

    await fixture.waitForOutput((output) => output.includes('Request failed'), 3000);
    const output = fixture.output();
    expect(output).toContain('[Server] Request failed');
    expect(output).toContain("path: '/fail'");
    expect(output).toContain('fixture failure'); // the error itself rides the line
  }, 30000);

  it('ordinary static requests are untouched: a held file serves 200, a missing one is 404', async () => {
    fixture = await startFixture();

    const served = await request(fixture.port, {
      method: 'GET',
      path: '/static/asset.txt',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    expect(served.status).toBe(200);
    expect(served.body).toBe('fixture static asset\n');

    const missing = await request(fixture.port, {
      method: 'GET',
      path: '/static/missing.txt',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    expect(missing.status).toBe(404);
  }, 30000);
});

type Fixture = {
  child: ChildProcess;
  port: number;
  output: () => string;
  waitForOutput: (ready: (output: string) => boolean, timeoutMs: number) => Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

async function startFixture(): Promise<Fixture> {
  const port = await ephemeralPort();
  // Scrub the env vars startServer reads (dev machines export some of these): the fixture's
  // behavior must come from its own config only. NODE_ENV in particular: the test runner sets
  // it to 'test', under which express's default handler prints nothing — the served shape has
  // no such env, and this suite asserts what the served process writes.
  const env = { ...process.env };
  delete env.SERVER_PORT;
  delete env.DEVELOPMENT;
  delete env.DISABLE_HOT_CLIENT_BUILDS;
  delete env.HMR_PORT;
  delete env.NODE_ENV;
  delete env.LOG_LEVEL;
  const child = spawn(process.execPath, [fixturePath], {
    cwd: packageRoot,
    env: { ...env, FIXTURE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The served process writes through the dev log writer, which colors its output; the suite
  // reads the words, so the escape codes are stripped from what it sees.
  let raw = '';
  const output = () => raw.replace(ANSI_ESCAPE, '');
  child.stdout!.on('data', (chunk) => (raw += String(chunk)));
  child.stderr!.on('data', (chunk) => (raw += String(chunk)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  );
  const waitForOutput = async (ready: (output: string) => boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (!ready(output())) {
      if (Date.now() > deadline) {
        throw new Error(`Fixture output never satisfied the condition within ${timeoutMs}ms; output:\n${output()}`);
      }
      await sleep(25);
    }
  };
  // Ready = the health check answers 200 (readiness through the front door, not log lines).
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Fixture exited during boot; output:\n${output()}`);
    }
    const result = await request(port, { method: 'GET', path: '/health-check' }).catch(() => undefined);
    if (result?.status === 200) {
      return { child, port, output, waitForOutput, exited };
    }
    if (Date.now() > deadline) {
      throw new Error(`Fixture never became ready; output:\n${output()}`);
    }
    await sleep(100);
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

/** One request on its OWN connection (agent: false — no keep-alive pooling). */
function request(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string> }
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method, path: options.path, agent: false, headers: options.headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += String(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * A JSON POST that declares `declaredLength` bytes, sends `sentLength` of them, then drops the
 * connection: the sender hung up mid-body — the body parser is still reading when the socket
 * goes away.
 */
function abortMidBody(port: number, requestPath: string, declaredLength: number, sentLength: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(
        `POST ${requestPath} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'X-Forwarded-Proto: https\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${declaredLength}\r\n` +
          '\r\n' +
          '{'.padEnd(sentLength, ' '),
        () => {
          // Let the bytes reach the server's parser before the connection is torn down.
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 100);
        }
      );
    });
    socket.on('error', reject);
  });
}

async function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
