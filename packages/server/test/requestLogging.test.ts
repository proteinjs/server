import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * The request log, on a real server process (spawns the built dist — run `npm run build` first).
 * `wrapRoute` writes a `Started <url>` / `Finished <url>` pair for every routed request unless
 * `shouldLogRequest` says otherwise.
 *
 * Its exclusions: the readiness route `/health-check` is polled continuously by whatever fronts the
 * process (a load balancer's health checker, a kubelet's readiness and liveness probes — every
 * couple of seconds per instance, forever), and each poll wrote a pair: paid log ingestion carrying
 * no signal. This suite pins the exclusion at its one owner, and pins that it is EXACT — a page
 * whose path merely begins with `/health-check` is an ordinary request and stays logged.
 *
 * Its url: the path and the query's KEYS, never a query VALUE. A reset link, an invite link and the
 * reset page's token check all carry a live credential in their query, and the log printed it
 * whole. The same form is the url the request's metadata carries — what a consumer's log writer
 * attaches to every line the request writes.
 *
 * Asserted through the front door: the fixture runs with request logging on (its served shape),
 * the suite drives the routes and reads the process's stdout.
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');

type Fixture = {
  child: ChildProcess;
  port: number;
  stdout: () => string;
  waitForLine: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

describe('request logging exclusions', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
  });

  it('/health-check is never logged; every other route still gets its Started/Finished pair', async () => {
    fixture = await startFixture();

    // The probe shape: plain HTTP to the serving port (no forwarded proto), as the LB health
    // checker and the kubelet send it. Several, like a probe loop.
    for (let i = 0; i < 3; i++) {
      const probe = await request(fixture.port, '/health-check');
      expect(probe.status).toBe(200);
    }

    // An ordinary routed request (the '*' react-app route) — the positive control that logging is
    // on and untouched for everything else. The forwarded proto clears the https redirect the
    // prod shape applies in front of the page routes.
    const page = await request(fixture.port, '/some-page', { 'X-Forwarded-Proto': 'https' });
    expect(page.status).toBe(200);
    await fixture.waitForLine(/Finished \/some-page$/m);

    const log = fixture.stdout();
    expect(log).toMatch(/Started \/some-page$/m);
    expect(log).toMatch(/Finished \/some-page$/m);
    // Not one line for the readiness route — neither from the suite's probes above nor from the
    // boot's readiness polling in startFixture (the same route, the same shape).
    expect(log).not.toMatch(/Started \/health-check$/m);
    expect(log).not.toMatch(/Finished \/health-check$/m);
  }, 30000);

  it('the exclusion is exact: a path that merely begins with /health-check is logged like any other', async () => {
    fixture = await startFixture();

    const page = await request(fixture.port, '/health-check-page', { 'X-Forwarded-Proto': 'https' });
    expect(page.status).toBe(200);
    await fixture.waitForLine(/Finished \/health-check-page$/m);

    const log = fixture.stdout();
    expect(log).toMatch(/Started \/health-check-page$/m);
    expect(log).toMatch(/Finished \/health-check-page$/m);
    expect(log).not.toMatch(/Started \/health-check$/m);
  }, 30000);
});

describe('the request log carries the query keys, never their values', () => {
  // A reset token's shape (64 hex) — any character run of it in a line is the value leaking.
  const token = 'abcd'.repeat(16);
  const thoughtId = 'thought-4242';
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
  });

  it('a credential in the query: the Started/Finished lines keep the key and print the mark', async () => {
    fixture = await startFixture();

    const page = await request(fixture.port, `/some-page?token=${token}`, { 'X-Forwarded-Proto': 'https' });
    expect(page.status).toBe(200);
    await fixture.waitForLine(/Finished \/some-page/m);

    const lines = requestLines(fixture.stdout());
    expect(lines).toContainEqual(expect.stringMatching(/Started \/some-page\?token=<redacted>$/));
    expect(lines).toContainEqual(expect.stringMatching(/Finished \/some-page\?token=<redacted>$/));
    expect(lines.filter((line) => line.includes('abcd'))).toEqual([]);
  }, 30000);

  it('the request metadata a log writer attaches to every line carries the same form', async () => {
    fixture = await startFixture();

    await request(fixture.port, `/some-page?token=${token}`, { 'X-Forwarded-Proto': 'https' });
    await fixture.waitForLine(/REQUEST_METADATA_URL \/some-page/m);

    const log = fixture.stdout();
    expect(log).toMatch(/^REQUEST_METADATA_URL \/some-page\?token=<redacted>$/m);
    expect(log).not.toContain('abcd');
  }, 30000);

  it('a request with no query logs its path unchanged', async () => {
    fixture = await startFixture();

    await request(fixture.port, '/some-page', { 'X-Forwarded-Proto': 'https' });
    await fixture.waitForLine(/REQUEST_METADATA_URL \/some-page/m);

    const log = fixture.stdout();
    expect(log).toMatch(/Started \/some-page$/m);
    expect(log).toMatch(/Finished \/some-page$/m);
    expect(log).toMatch(/^REQUEST_METADATA_URL \/some-page$/m);
  }, 30000);

  it('two keys: both keys kept in their order, neither value', async () => {
    fixture = await startFixture();

    await request(fixture.port, `/some-page?id=${thoughtId}&invite=${token}`, { 'X-Forwarded-Proto': 'https' });
    await fixture.waitForLine(/REQUEST_METADATA_URL \/some-page/m);

    const log = fixture.stdout();
    expect(log).toMatch(/Started \/some-page\?id=<redacted>&invite=<redacted>$/m);
    expect(log).toMatch(/Finished \/some-page\?id=<redacted>&invite=<redacted>$/m);
    expect(log).toMatch(/^REQUEST_METADATA_URL \/some-page\?id=<redacted>&invite=<redacted>$/m);
    expect(log).not.toContain(thoughtId);
    expect(log).not.toContain('abcd');
  }, 30000);

  it('a query piece with no key is all value: the mark replaces it whole', async () => {
    fixture = await startFixture();

    await request(fixture.port, `/some-page?${token}`, { 'X-Forwarded-Proto': 'https' });
    await fixture.waitForLine(/REQUEST_METADATA_URL \/some-page/m);

    const log = fixture.stdout();
    expect(log).toMatch(/Started \/some-page\?<redacted>$/m);
    expect(log).not.toContain('abcd');
  }, 30000);

  it('a fragment the client sent: its content never prints, with or without a query', async () => {
    // A browser keeps the fragment to itself, but the request target is whatever the client wrote,
    // and node hands a `#…` through in the url. A link's fragment is where a credential can ride.
    fixture = await startFixture();

    await request(fixture.port, `/some-page#access=${token}`, { 'X-Forwarded-Proto': 'https' });
    await fixture.waitForLine(/REQUEST_METADATA_URL \/some-page/m);
    await request(fixture.port, `/other-page?id=${thoughtId}#access=${token}`, { 'X-Forwarded-Proto': 'https' });
    await fixture.waitForLine(/REQUEST_METADATA_URL \/other-page/m);

    const log = fixture.stdout();
    expect(log).toMatch(/Started \/some-page#<redacted>$/m);
    expect(log).toMatch(/Finished \/some-page#<redacted>$/m);
    expect(log).toMatch(/^REQUEST_METADATA_URL \/some-page#<redacted>$/m);
    expect(log).toMatch(/Started \/other-page\?id=<redacted>#<redacted>$/m);
    expect(log).toMatch(/^REQUEST_METADATA_URL \/other-page\?id=<redacted>#<redacted>$/m);
    expect(log).not.toContain('abcd');
    expect(log).not.toContain(thoughtId);
  }, 30000);

  it('the Timed-out line — the request timeout firing on a request still arriving — carries the same form', async () => {
    // A short request timeout, and a request whose body never finishes arriving (Content-Length
    // 10, three bytes sent) to the fixture's routed /slow-route: the route runs on the headers, the
    // socket idles, the timeout fires while the message is still incomplete — the one shape node
    // hands to the request's timeout callback — and the request log writes its Timed-out line, the
    // third line that prints the url.
    fixture = await startFixture({ FIXTURE_REQUEST_TIMEOUT_MS: '200' });

    const socket = net.connect(fixture.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      `GET /slow-route?token=${token}&ms=1500 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-Proto: https\r\nContent-Length: 10\r\n\r\nabc`
    );
    try {
      await fixture.waitForLine(/Timed out \/slow-route/m);
    } finally {
      socket.destroy();
    }

    const log = fixture.stdout();
    expect(log).toMatch(/Started \/slow-route\?token=<redacted>&ms=<redacted>$/m);
    expect(log).toMatch(/Timed out \/slow-route\?token=<redacted>&ms=<redacted>$/m);
    expect(log).not.toContain('abcd');
  }, 30000);
});

/** The request log's own lines: the Started/Finished pair wrapRoute writes. */
function requestLines(log: string): string[] {
  return log.split('\n').filter((line) => /\b(Started|Finished) \//.test(line));
}

/** @param fixtureEnv the fixture's own switches (FIXTURE_*), on top of the scrubbed environment. */
async function startFixture(fixtureEnv: Record<string, string> = {}): Promise<Fixture> {
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
    env: { ...env, ...fixtureEnv, FIXTURE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  // The dev log writer colors its lines; the assertions read the plain text. The escape is built,
  // not written: a control character in a regex literal is what eslint's no-control-regex refuses.
  const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const stripAnsi = (text: string) => text.replace(ansiColor, '');
  child.stdout!.on('data', (chunk) => (output += stripAnsi(String(chunk))));
  child.stderr!.on('data', (chunk) => (output += stripAnsi(String(chunk))));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  );
  const waitForLine = async (pattern: RegExp, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(output)) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${pattern}; output so far:\n${output}`);
      }
      await sleep(25);
    }
  };
  // Ready = the health check answers 200 (readiness through the front door, not log lines).
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Fixture exited during boot; output:\n${output}`);
    }
    const result = await request(port, '/health-check').catch(() => undefined);
    if (result?.status === 200) {
      return { child, port, stdout: () => output, waitForLine, exited };
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
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath, agent: false, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += String(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}
