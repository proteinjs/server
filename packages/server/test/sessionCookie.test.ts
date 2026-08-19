import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * Session-cookie attribute contract of a real server process (spawns the built dist — run
 * `npm run build` first). Asserted through the front door: the fixture's /session-cookie
 * endpoint touches the session, express-session emits Set-Cookie, and this suite reads the
 * attributes off the emitted header — the cookie browsers actually receive, not a copy of the
 * config.
 *
 * The attributes pinned here are the session cookie's security posture:
 * - `SameSite=Lax` — explicit CSRF hardening: cross-site subrequests (POSTs, iframes, images)
 *   never carry the session cookie; top-level navigations still do, so links into the app stay
 *   signed in. Express-session's default omits the attribute entirely, leaving the policy to
 *   browser defaults — the policy must be the server's, stated on the cookie.
 * - `HttpOnly` — no script access to the session id.
 * - `Secure` — the fixture runs the prod shape (no DEVELOPMENT), where cookies are marked
 *   Secure and only issued on connections the server considers secure (trust proxy 1 +
 *   X-Forwarded-Proto, the load-balancer topology).
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');

describe('session cookie attributes', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
  });

  it('the session cookie is explicitly SameSite=Lax, HttpOnly, and Secure', async () => {
    fixture = await startFixture();

    // The LB topology in miniature: trust proxy is 1 in the prod shape, so the forwarded proto
    // marks the request secure and the Secure-flagged cookie is actually issued.
    const result = await request(fixture.port, '/session-cookie', { 'X-Forwarded-Proto': 'https' });
    expect(result.status).toBe(200);

    const setCookie = result.setCookie.find((value) => value.startsWith('connect.sid='));
    expect(setCookie).toBeDefined();
    const attributes = setCookie!
      .split(';')
      .slice(1)
      .map((attribute) => attribute.trim().toLowerCase());
    expect(attributes).toContain('samesite=lax');
    expect(attributes).toContain('httponly');
    expect(attributes).toContain('secure');
  }, 30000);

  it('an insecure request in the prod shape gets NO session cookie at all', async () => {
    fixture = await startFixture();

    // No X-Forwarded-Proto: the connection is plain http, so the Secure-only cookie must not be
    // issued (a Secure cookie set over http would be silently dropped by browsers anyway — the
    // server must not pretend otherwise).
    const result = await request(fixture.port, '/session-cookie');
    expect(result.status).toBe(200);
    expect(result.setCookie).toEqual([]);
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
  // behavior must come from its own config only — DEVELOPMENT in particular would drop the
  // prod cookie shape (Secure) this suite asserts.
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

/** One request on its OWN connection (agent: false — no keep-alive pooling). */
function request(
  port: number,
  requestPath: string,
  headers?: Record<string, string>
): Promise<{ status: number; body: string; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath, agent: false, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += String(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, setCookie: res.headers['set-cookie'] ?? [] }));
      res.on('error', reject);
    });
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
