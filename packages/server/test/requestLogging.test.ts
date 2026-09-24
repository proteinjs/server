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
 * Its metadata is the request's OWN on a reused keep-alive connection. Every request on a
 * connection is dispatched inside that connection's async lineage, so the connection carried the
 * first request's metadata to every later one; the metadata is first-write-wins, so the later
 * requests' own was silently dropped and every line they wrote named the first request — and the
 * lines written before a route (the session store's read) and socket.io's polling requests (which
 * never reach a route) named it too. A line written before its request's route carries no
 * request's metadata; never another request's.
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

describe('each request on a reused keep-alive connection carries its own request metadata', () => {
  const https = { 'X-Forwarded-Proto': 'https' };
  let fixture: Fixture | undefined;
  let agent: http.Agent | undefined;

  afterEach(async () => {
    agent?.destroy();
    agent = undefined;
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
  });

  it('a second request dispatched in the connection’s own context: its own number and url', async () => {
    fixture = await startFixture();
    // One socket, kept alive: the second request rides the first one's connection.
    agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    const first = await request(fixture.port, '/first-page', https, agent);
    const second = await request(fixture.port, '/second-page', https, agent);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.reusedSocket).toBe(true);
    await fixture.waitForLine(/^REQUEST_METADATA \/second-page /m);

    const firstRead = metadataRead(fixture.stdout(), '/first-page');
    expect(firstRead.url).toBe('/first-page');
    expect(metadataRead(fixture.stdout(), '/second-page')).toEqual({
      number: firstRead.number + 1,
      url: '/second-page',
    });
  }, 30000);

  it('a second request dispatched behind the session store’s read (a visitor with a session): its own number and url', async () => {
    fixture = await startFixture();
    // Carrying a session cookie makes the session middleware read the store, and the store answers
    // on a later turn — the request is dispatched in a continuation born inside the connection's
    // lineage, not in the connection's own context.
    const cookie = await sessionCookie(fixture.port);
    agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    const first = await request(fixture.port, '/first-page', https, agent);
    const second = await request(fixture.port, '/second-page', { ...https, Cookie: cookie }, agent);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.reusedSocket).toBe(true);
    await fixture.waitForLine(/^REQUEST_METADATA \/second-page /m);

    const firstRead = metadataRead(fixture.stdout(), '/first-page');
    expect(firstRead.url).toBe('/first-page');
    expect(metadataRead(fixture.stdout(), '/second-page')).toEqual({
      number: firstRead.number + 1,
      url: '/second-page',
    });
  }, 30000);

  it('a line written before the route (the session store’s read, behind a cookie) carries no request’s metadata, never the previous one’s', async () => {
    fixture = await startFixture();
    const cookie = await sessionCookie(fixture.port);
    agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    await request(fixture.port, '/first-page', https, agent);
    const second = await request(fixture.port, '/second-page', { ...https, Cookie: cookie }, agent);
    expect(second.status).toBe(200);
    expect(second.reusedSocket).toBe(true);
    await fixture.waitForLine(/^REQUEST_METADATA \/second-page /m);

    // The store is read once — by the second request, in front of its route, before the request
    // has a number of its own.
    expect(markerReads(fixture.stdout(), 'SESSION_READ_METADATA')).toEqual(['none']);
    expect(metadataRead(fixture.stdout(), '/second-page').url).toBe('/second-page');
  }, 30000);

  it('a socket.io polling request on the connection carries no request’s metadata, never the previous one’s', async () => {
    fixture = await startFixture();
    await fixture.waitForLine(/^FIXTURE_READY$/m);
    agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    await request(fixture.port, '/first-page', https, agent);
    // socket.io's engine answers its own path ahead of the app: the polling handshake never
    // reaches a route.
    const polling = await request(fixture.port, '/socket.io/?EIO=4&transport=polling', undefined, agent);
    expect(polling.status).toBe(200);
    expect(polling.reusedSocket).toBe(true);
    await fixture.waitForLine(/^SOCKET_IO_CONNECTION_METADATA /m);

    expect(markerReads(fixture.stdout(), 'SOCKET_IO_CONNECTION_METADATA')).toEqual(['none']);
  }, 30000);

  it('a request dispatched from inside another request’s lineage (a hand-off): each keeps its own', async () => {
    fixture = await startFixture();
    // The parked request's dispatch is held in front of the routes; the releasing request runs it
    // from its own after-request seam, then reads its own metadata.
    const parked = request(fixture.port, '/parked-page', https);
    await fixture.waitForLine(/^PARKED \/parked-page$/m);
    const releasing = await request(fixture.port, '/first-page?release=1', https);
    const parkedResponse = await parked;
    expect([releasing.status, parkedResponse.status]).toEqual([200, 200]);
    await fixture.waitForLine(/^REQUEST_METADATA \/parked-page /m);

    const releasingRead = metadataRead(fixture.stdout(), '/first-page');
    const parkedRead = metadataRead(fixture.stdout(), '/parked-page');
    expect([releasingRead.url, parkedRead.url]).toEqual(['/first-page?release=<redacted>', '/parked-page']);
    expect(parkedRead.number).toBe(releasingRead.number + 1);
  }, 30000);
});

/** A session cookie (`connect.sid=…`), minted on its own connection. */
async function sessionCookie(port: number): Promise<string> {
  const minted = await request(port, '/session-cookie', { 'X-Forwarded-Proto': 'https' });
  return minted.setCookie.find((value) => value.startsWith('connect.sid='))!.split(';')[0];
}

/** Every value the fixture printed after `marker` (its `<marker> <value>` lines), in order. */
function markerReads(log: string, marker: string): string[] {
  return log
    .split('\n')
    .filter((line) => line.startsWith(`${marker} `))
    .map((line) => line.slice(marker.length + 1));
}

/**
 * The request metadata a log writer read inside the request whose own path is `requestPath` (the
 * fixture's REQUEST_METADATA line): the number and url every line that request writes carries.
 */
function metadataRead(log: string, requestPath: string): { number: number; url: string } {
  const reads = log
    .split('\n')
    .map((line) => /^REQUEST_METADATA (\S+) #(\d+) (\S+)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null && match[1] === requestPath);
  expect(reads).toHaveLength(1);
  return { number: Number(reads[0][2]), url: reads[0][3] };
}

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

/**
 * One request — on its OWN connection by default (agent: false, no keep-alive pooling), or on the
 * given agent's (a keep-alive agent reuses its connection across calls).
 */
function request(
  port: number,
  requestPath: string,
  headers?: Record<string, string>,
  agent: http.Agent | false = false
): Promise<{ status: number; body: string; setCookie: string[]; reusedSocket: boolean }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath, agent, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += String(chunk)));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body,
          setCookie: res.headers['set-cookie'] ?? [],
          reusedSocket: req.reusedSocket,
        })
      );
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
