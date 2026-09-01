import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * HTML cache policy of a real server process (spawns the built dist — run `npm run build`
 * first), asserted through the front door on the page the react-app route actually sends.
 *
 * THE CLASS THIS PINS (found live 2026-09-01, the mobile-app stale-page investigation): the
 * HTML response carried NO Cache-Control header — an ETag only. With no explicit policy,
 * HTTP heuristic caching applies (RFC 9111 §4.2.2), and WKWebView in particular can serve
 * the cached page without revalidating — across app force-quits — pinning stale bundle
 * POINTERS long after a deploy. The hashed bundles under /static keep their long cache (a
 * new page always points at new hashes); the PAGE must always revalidate. `no-cache` states
 * exactly that, and the ETag the response already carries keeps revalidation a cheap 304.
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');

describe('html cache policy', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
  });

  it('the react-app HTML response says Cache-Control: no-cache — the page always revalidates', async () => {
    fixture = await startFixture();

    const result = await request(fixture.port, '/');
    expect(result.status).toBe(200);
    // Sanity: this IS the react-app page (the configured bundle pointer is in the body).
    expect(result.body).toContain('bundles/app.test.js');
    expect(result.headers['content-type']).toContain('text/html');
    expect(result.headers['cache-control']).toBe('no-cache');
  }, 30000);

  it('every page path rides the same policy (the catch-all route is the one HTML owner)', async () => {
    fixture = await startFixture();

    const result = await request(fixture.port, '/chat');
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('text/html');
    expect(result.headers['cache-control']).toBe('no-cache');
  }, 30000);
});

type Fixture = {
  child: ChildProcess;
  port: number;
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
    const result = await request(port, '/health-check').catch(() => undefined);
    if (result?.status === 200) {
      return { child, port, exited };
    }
    if (Date.now() > deadline) {
      throw new Error(`Fixture never became ready; output:\n${output}`);
    }
    await sleep(100);
  }
}

/** One request on its OWN connection (agent: false — no keep-alive pooling). The forwarded
 *  proto is the LB topology in miniature: the prod shape 302s plain http to https. */
function request(
  port: number,
  requestPath: string
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: requestPath, agent: false, headers: { 'X-Forwarded-Proto': 'https' } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += String(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
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
