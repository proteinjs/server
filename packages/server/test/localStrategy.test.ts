import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * Local-strategy contract of a real server process (spawns the built dist — run `npm run build`
 * first), asserted through the front door.
 *
 * THE CLASS THIS PINS: a credential check never ends the process. When an `authenticate` function
 * is configured the framework registers a passport local strategy, and that strategy fires on any
 * request whose body or query carries its `username` and `password` fields — whatever the path.
 * The framework itself never runs the check on a request: such a request reaches its route like
 * any other, and the process is there to serve the next one. A consumer route that drives the
 * strategy (`passport.authenticate('local')`) gets passport's own answers — a wrong password is a
 * FAILURE (401), a right one a session, a failing check an ERROR (500) — never a rejection nobody
 * awaits.
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');

describe('the local strategy through the front door', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
  });

  it('a request carrying the strategy fields in the QUERY with a wrong password reaches its route; the process serves the next request', async () => {
    fixture = await startFixture();

    const outcome = await requestAndProcess(fixture, {
      method: 'GET',
      path: '/served?username=someone&password=wrong',
    });
    expect(outcome).toEqual({ served: { status: 200, body: 'served' }, process: 'alive' });

    const next = await request(fixture.port, { method: 'GET', path: '/health-check' });
    expect(next.status).toBe(200);
  }, 30000);

  it('a request carrying the strategy fields in a JSON BODY with a wrong password reaches its route; the process serves the next request', async () => {
    fixture = await startFixture();

    const outcome = await requestAndProcess(fixture, {
      method: 'POST',
      path: '/served',
      json: { username: 'someone', password: 'wrong' },
    });
    expect(outcome).toEqual({ served: { status: 200, body: 'served' }, process: 'alive' });

    const next = await request(fixture.port, { method: 'GET', path: '/health-check' });
    expect(next.status).toBe(200);
  }, 30000);

  it('a consumer route driving the strategy: a wrong password is refused 401, a right one is logged in', async () => {
    fixture = await startFixture();

    const wrong = await request(fixture.port, {
      method: 'POST',
      path: '/local-strategy',
      json: { username: 'someone', password: 'wrong' },
    });
    expect(wrong.status).toBe(401);

    const right = await request(fixture.port, {
      method: 'POST',
      path: '/local-strategy',
      json: { username: 'someone', password: 'right' },
    });
    expect(right).toMatchObject({ status: 200, body: 'logged in as someone' });
  }, 30000);

  it('a consumer route driving the strategy: a failing credential check is answered 500; the process serves the next request', async () => {
    fixture = await startFixture();

    const outcome = await requestAndProcess(fixture, {
      method: 'POST',
      path: '/local-strategy',
      json: { username: 'unavailable', password: 'right' },
    });
    expect(outcome).toEqual({ served: expect.objectContaining({ status: 500 }), process: 'alive' });

    const next = await request(fixture.port, { method: 'GET', path: '/health-check' });
    expect(next.status).toBe(200);
  }, 30000);
});

type Fixture = {
  child: ChildProcess;
  port: number;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

async function startFixture(): Promise<Fixture> {
  const port = await ephemeralPort();
  // Scrub the env vars startServer reads (dev machines export some of these): the fixture's
  // behavior must come from its own config only.
  const env = { ...process.env };
  delete env.SERVER_PORT;
  delete env.DEVELOPMENT;
  delete env.DISABLE_HOT_CLIENT_BUILDS;
  delete env.HMR_PORT;
  const child = spawn(process.execPath, [fixturePath], {
    cwd: packageRoot,
    env: { ...env, FIXTURE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (chunk) => (output += String(chunk)));
  child.stderr!.on('data', (chunk) => (output += String(chunk)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  );
  // Ready = the health check answers 200 (readiness through the front door, not log lines).
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Fixture exited during boot; output:\n${output}`);
    }
    const result = await request(port, { method: 'GET', path: '/health-check' }).catch(() => undefined);
    if (result?.status === 200) {
      return { child, port, output: () => output, exited };
    }
    if (Date.now() > deadline) {
      throw new Error(`Fixture never became ready; output:\n${output}`);
    }
    await sleep(100);
  }
}

/**
 * One request, and what became of the process that served it: the answer (or the failure the
 * client saw), and whether the process is still there afterwards — a process the request ended
 * has exited by then; one that lives is still running 300ms later.
 */
async function requestAndProcess(fixture: Fixture, options: RequestOptions) {
  const served = await request(fixture.port, options).then(
    ({ status, body }) => ({ status, body }),
    (error: Error) => ({ failed: error.message })
  );
  const process = await Promise.race([
    fixture.exited.then((exit) => ({ exited: exit, output: fixture.output() })),
    sleep(300).then(() => 'alive' as const),
  ]);
  return { served, process };
}

type RequestOptions = { method: string; path: string; headers?: Record<string, string>; json?: unknown };

/** One request on its OWN connection (agent: false — no keep-alive pooling). */
function request(
  port: number,
  options: RequestOptions
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = options.json === undefined ? undefined : JSON.stringify(options.json);
    const headers: Record<string, string> = { ...options.headers };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method, path: options.path, agent: false, headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += String(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(payload);
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
