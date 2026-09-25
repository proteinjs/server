import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * EVERY PAGE REFUSES FRAMING, from one owner (`PageSecurityHeaders` — a real server process: spawns
 * the built dist; run `npm run build` first), asserted through the front door on the responses the
 * server actually sends.
 *
 * THE CLASS THIS PINS: a page with no framing policy can be framed by any site — the clickjacking
 * shape (an invisible frame over a decoy, the visitor's click landing on the page's own controls).
 * The server's pages carried NO such header (found at the public-page posture review, 2026-09).
 * Now every document — the SPA shell, a consumer route's HTML, the framework's own error page —
 * carries `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, and a
 * route may declare itself `frameable` (its own origin, plus the origins the deployment lists in
 * `ServerConfig.pages.frameAncestors`). Non-documents (JSON, an empty answer, file bytes) carry no
 * framing header: they render no UI to redress. `X-Content-Type-Options: nosniff` rides every
 * response (a script or style served as another type must not be sniffed into one) and documents
 * carry `Referrer-Policy: strict-origin-when-cross-origin` (a page's outbound cross-origin
 * requests send the origin only — never a path carrying a reset or invite token).
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');

const REFUSES_FRAMING = "frame-ancestors 'none'";
const REFERRER_POLICY = 'strict-origin-when-cross-origin';

describe('page security headers', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
  });

  it('the SPA shell refuses framing on every page path: frame-ancestors none + X-Frame-Options DENY', async () => {
    fixture = await startFixture();

    for (const pagePath of ['/', '/chat']) {
      const page = await request(fixture.port, pagePath);
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.body).toContain('bundles/app.test.js');
      expect(page.headers['content-security-policy']).toContain(REFUSES_FRAMING);
      expect(page.headers['x-frame-options']).toBe('DENY');
      expect(page.headers['referrer-policy']).toBe(REFERRER_POLICY);
      expect(page.headers['x-content-type-options']).toBe('nosniff');
    }
  }, 30000);

  it("a consumer route's HTML page and the framework's own error page refuse framing too", async () => {
    fixture = await startFixture();

    const page = await request(fixture.port, '/plain-page');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('/plain-page');
    expect(page.headers['content-security-policy']).toContain(REFUSES_FRAMING);
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['referrer-policy']).toBe(REFERRER_POLICY);

    // No route answers a POST here: express's own 404 page — a document like any other. Its own
    // policy (`default-src 'none'`) stays beside ours: one header, both policies enforced.
    const notFound = await request(fixture.port, '/no-such-route', 'POST');
    expect(notFound.status).toBe(404);
    expect(notFound.headers['content-type']).toContain('text/html');
    expect(notFound.headers['content-security-policy']).toContain("default-src 'none'");
    expect(notFound.headers['content-security-policy']).toContain(REFUSES_FRAMING);
    expect(notFound.headers['x-frame-options']).toBe('DENY');
  }, 30000);

  it('a non-document carries no framing header — JSON, an empty answer, file bytes — and nosniff on each', async () => {
    fixture = await startFixture();

    const json = await request(fixture.port, '/server-timeouts');
    expect(json.status).toBe(200);
    expect(json.headers['content-type']).toContain('application/json');
    expect(json.headers['content-security-policy']).toBeUndefined();
    expect(json.headers['x-frame-options']).toBeUndefined();
    expect(json.headers['referrer-policy']).toBeUndefined();
    expect(json.headers['x-content-type-options']).toBe('nosniff');

    const empty = await request(fixture.port, '/health-check');
    expect(empty.status).toBe(200);
    expect(empty.headers['content-type']).toBeUndefined();
    expect(empty.headers['content-security-policy']).toBeUndefined();
    expect(empty.headers['x-frame-options']).toBeUndefined();
    expect(empty.headers['x-content-type-options']).toBe('nosniff');

    // The fixture's static dir is its own directory: this file's bytes, served by express.static.
    const bytes = await request(fixture.port, '/static/gracefulShutdownServer.js');
    expect(bytes.status).toBe(200);
    expect(bytes.headers['content-type']).toContain('javascript');
    expect(bytes.headers['content-security-policy']).toBeUndefined();
    expect(bytes.headers['x-frame-options']).toBeUndefined();
    expect(bytes.headers['x-content-type-options']).toBe('nosniff');
  }, 30000);

  it('a route that declares frameable is framed by its own origin only when the deployment lists none', async () => {
    fixture = await startFixture();

    const page = await request(fixture.port, '/frameable-page');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    expect(page.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(page.headers['referrer-policy']).toBe(REFERRER_POLICY);
  }, 30000);

  it("the deployment's list widens a frameable route to the listed origins; an undeclared page still refuses", async () => {
    fixture = await startFixture({ FIXTURE_FRAME_ANCESTORS: 'https://www.example.com https://embed.example.org:8443' });

    const page = await request(fixture.port, '/frameable-page');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' https://www.example.com https://embed.example.org:8443"
    );
    // X-Frame-Options has no value for a cross-origin list (ALLOW-FROM is dead): omitted, so the
    // one header a browser without frame-ancestors support would read does not refuse the framer
    // the deployment allowed. Every browser with frame-ancestors ignores X-Frame-Options anyway.
    expect(page.headers['x-frame-options']).toBeUndefined();

    const shell = await request(fixture.port, '/');
    expect(shell.headers['content-security-policy']).toContain(REFUSES_FRAMING);
    expect(shell.headers['x-frame-options']).toBe('DENY');
    const plain = await request(fixture.port, '/plain-page');
    expect(plain.headers['content-security-policy']).toContain(REFUSES_FRAMING);
    expect(plain.headers['x-frame-options']).toBe('DENY');
  }, 30000);

  it('a listed entry that is not an origin refuses to boot — never a policy the browser would misread', async () => {
    const boot = await bootOutcome({ FIXTURE_FRAME_ANCESTORS: 'https://www.example.com/embed' });
    if (boot.ready) {
      fixture = boot.fixture; // a server that booted on a bad list is the failure — and afterEach's to stop
    }
    expect(boot.ready).toBe(false);
    expect(boot.output).toContain('https://www.example.com/embed');
    expect(boot.output).toContain('frameAncestors');
  }, 30000);
});

type Fixture = {
  child: ChildProcess;
  port: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

async function startFixture(extraEnv: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const boot = await bootOutcome(extraEnv);
  if (!boot.ready) {
    throw new Error(`Fixture never became ready; output:\n${boot.output}`);
  }
  return boot.fixture;
}

/**
 * Spawns the fixture and waits for its health check (readiness through the front door, not log
 * lines) — or for it to exit, the outcome of a config the server refuses.
 */
async function bootOutcome(
  extraEnv: NodeJS.ProcessEnv
): Promise<{ ready: true; fixture: Fixture; output: string } | { ready: false; output: string }> {
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
    env: { ...env, ...extraEnv, FIXTURE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (chunk) => (output += String(chunk)));
  child.stderr!.on('data', (chunk) => (output += String(chunk)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  );
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { ready: false, output };
    }
    const result = await request(port, '/health-check').catch(() => undefined);
    if (result?.status === 200) {
      return { ready: true, fixture: { child, port, exited }, output };
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      await exited.catch(() => undefined);
      return { ready: false, output: `(timed out)\n${output}` };
    }
    await sleep(100);
  }
}

/** One request on its OWN connection (agent: false — no keep-alive pooling). The forwarded
 *  proto is the LB topology in miniature: the prod shape 302s plain http to https. */
function request(
  port: number,
  requestPath: string,
  method: 'GET' | 'POST' = 'GET'
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method,
        agent: false,
        headers: { 'X-Forwarded-Proto': 'https', 'Content-Length': 0 },
      },
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
