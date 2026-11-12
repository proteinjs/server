import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * THE HEADERS THE SERVER'S RESPONSES CARRY, read through the front door of a real server process
 * (spawns the built dist — run `npm run build` first) on the responses it actually sends: the HTML
 * cache policy of the page, and the security headers every response carries from one owner
 * (`PageSecurityHeaders`), by the response's class.
 *
 * THE CACHE CLASS (found live 2026-09-01, the mobile-app stale-page investigation): the HTML
 * response carried NO Cache-Control header — an ETag only. With no explicit policy, HTTP heuristic
 * caching applies (RFC 9111 §4.2.2), and WKWebView in particular can serve the cached page without
 * revalidating — across app force-quits — pinning stale bundle POINTERS long after a deploy. The
 * hashed bundles under /static keep their long cache (a new page always points at new hashes); the
 * PAGE must always revalidate. `no-cache` states exactly that, and the ETag the response already
 * carries keeps revalidation a cheap 304.
 *
 * THE SECURITY CLASSES: a page with no framing policy can be framed by any site — the clickjacking
 * shape (an invisible frame over a decoy, the visitor's click landing on the page's own controls);
 * a response with no `nosniff` can be sniffed into a script; a page with no referrer policy sends a
 * reset link's path to every cross-origin host it loads from; a host with no Strict-Transport-Security
 * is reached over plain http by any link or typed address until that request's own redirect; a page
 * with no Permissions-Policy lets any script in it turn on the camera or the microphone; and a page
 * with no Content-Security-Policy runs whatever an injection puts in it. The server's pages carried
 * none of these headers (found at the public-page posture review, 2026-09; the edge review, 2026-11),
 * and the answers socket.io and its transport serve AHEAD of express, off their own paths, carried
 * none even once the pages did (the edge review's refuter, 2026-11-09). Now the owner sits on the
 * http server itself, first of its listeners: every document carries `Content-Security-Policy:
 * frame-ancestors 'none'`, `X-Frame-Options: DENY` and `Referrer-Policy:
 * strict-origin-when-cross-origin`, a route may declare itself `frameable`, `X-Content-Type-Options:
 * nosniff` rides every response — the transport's long-polling answers, its refusals, socket.io's
 * client script and the WebSocket upgrade's 101 included — and the deployment's
 * declarations (`ServerConfig.pages`) add Strict-Transport-Security on every https response,
 * Permissions-Policy on every document, and a Content-Security-Policy — report-only or enforced —
 * whose reports the server takes at /csp-report and logs. The https redirect sends a plain-http
 * request to the declared origin (`ServerConfig.origin`), never to the Host header the request carried.
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');

const REFUSES_FRAMING = "frame-ancestors 'none'";
const REFERRER_POLICY = 'strict-origin-when-cross-origin';
const ORIGIN = 'https://app.example.com';
const HSTS = 'max-age=31536000; includeSubDomains';
const DECLARED_PAGES = {
  strictTransportSecurity: { maxAgeSeconds: 31536000, includeSubDomains: true },
  permissionsPolicy: { camera: ['self'], microphone: ['self'], geolocation: [] },
  contentSecurityPolicy: {
    reportOnly: true,
    directives: { 'default-src': ["'self'"], 'script-src': ["'self'", "'unsafe-inline'"], 'object-src': ["'none'"] },
  },
};
const DECLARED_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'; report-uri /csp-report";

describe('html cache policy', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    await stop(fixture);
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

describe('page security headers', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    await stop(fixture);
    fixture = undefined;
  });

  it('every document refuses framing and carries the referrer policy; every response carries nosniff; a non-document carries no framing header', async () => {
    fixture = await startFixture();

    // The SPA shell on every page path, and a consumer route's own HTML page.
    for (const pagePath of ['/', '/chat', '/plain-page']) {
      const page = await request(fixture.port, pagePath);
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.headers['content-security-policy']).toBe(REFUSES_FRAMING);
      expect(page.headers['x-frame-options']).toBe('DENY');
      expect(page.headers['referrer-policy']).toBe(REFERRER_POLICY);
      expect(page.headers['x-content-type-options']).toBe('nosniff');
      // No declaration, no deployment header.
      expect(page.headers['strict-transport-security']).toBeUndefined();
      expect(page.headers['permissions-policy']).toBeUndefined();
      expect(page.headers['content-security-policy-report-only']).toBeUndefined();
    }
    expect((await request(fixture.port, '/')).body).toContain('bundles/app.test.js');

    // No route answers a POST here: express's own 404 page — a document like any other. Its own
    // policy (`default-src 'none'`) stays beside ours: one header, both policies enforced.
    const notFound = await request(fixture.port, '/no-such-route', 'POST');
    expect(notFound.status).toBe(404);
    expect(notFound.headers['content-type']).toContain('text/html');
    expect(notFound.headers['content-security-policy']).toContain("default-src 'none'");
    expect(notFound.headers['content-security-policy']).toContain(REFUSES_FRAMING);
    expect(notFound.headers['x-frame-options']).toBe('DENY');

    // JSON, an empty answer and file bytes (the fixture's static dir is its own directory) render
    // no UI to redress and initiate no request of their own: nosniff alone.
    const json = await request(fixture.port, '/server-timeouts');
    expect(json.headers['content-type']).toContain('application/json');
    const empty = await request(fixture.port, '/health-check');
    expect(empty.headers['content-type']).toBeUndefined();
    const bytes = await request(fixture.port, '/static/gracefulShutdownServer.js');
    expect(bytes.headers['content-type']).toContain('javascript');
    for (const other of [json, empty, bytes]) {
      expect(other.status).toBe(200);
      expect(other.headers['x-content-type-options']).toBe('nosniff');
      expect(other.headers['content-security-policy']).toBeUndefined();
      expect(other.headers['x-frame-options']).toBeUndefined();
      expect(other.headers['referrer-policy']).toBeUndefined();
    }
  }, 30000);

  it("the deployment's declarations: Strict-Transport-Security on every https response, Permissions-Policy and the report-only policy on documents alone, the https redirect to the declared origin", async () => {
    fixture = await startFixture({ FIXTURE_ORIGIN: ORIGIN, FIXTURE_PAGES: JSON.stringify(DECLARED_PAGES) });

    const page = await request(fixture.port, '/chat');
    expect(page.status).toBe(200);
    expect(page.headers['strict-transport-security']).toBe(HSTS);
    expect(page.headers['permissions-policy']).toBe('camera=(self), microphone=(self), geolocation=()');
    expect(page.headers['content-security-policy-report-only']).toBe(DECLARED_CSP);
    // Report-only reports; the framing refusal stays enforced — and, with the door mounted, names
    // it: a page the app frames from its own origin that this refuses is a logged violation, never
    // a silent blank frame (the report-only policy never carries the framing directive).
    expect(page.headers['content-security-policy']).toBe(`${REFUSES_FRAMING}; report-uri /csp-report`);
    expect(page.headers['x-frame-options']).toBe('DENY');

    // HSTS rides every https response, whatever its class; the document-only headers do not.
    for (const otherPath of ['/server-timeouts', '/health-check', '/static/gracefulShutdownServer.js']) {
      const other = await request(fixture.port, otherPath);
      expect(other.status).toBe(200);
      expect(other.headers['strict-transport-security']).toBe(HSTS);
      expect(other.headers['permissions-policy']).toBeUndefined();
      expect(other.headers['content-security-policy-report-only']).toBeUndefined();
    }

    // A plain-http request (no forwarded https) is redirected to the DECLARED origin with its path and
    // query — the Host header it carried names no part of the Location — and, being plain http,
    // carries no Strict-Transport-Security (a browser would ignore it there).
    const plain = await request(fixture.port, '/chat?id=7&x=1', 'GET', { forwardedHttps: false, host: 'evil.example' });
    expect(plain.status).toBe(302);
    expect(plain.headers.location).toBe(`${ORIGIN}/chat?id=7&x=1`);
    expect(plain.headers['strict-transport-security']).toBeUndefined();
    expect(plain.headers['x-content-type-options']).toBe('nosniff');
  }, 30000);

  it("the socket transport's answers carry them too — the long-polling handshake, a poll, the transport's own refusal, socket.io's client script and the WebSocket upgrade's 101", async () => {
    fixture = await startFixture({ FIXTURE_ORIGIN: ORIGIN, FIXTURE_PAGES: JSON.stringify(DECLARED_PAGES) });

    // socket.io and engine.io intercept /socket.io/ ahead of express: no middleware ever sees these answers.
    const open = await request(fixture.port, '/socket.io/?EIO=4&transport=polling');
    expect(open.status).toBe(200);
    expect(open.body.startsWith('0{')).toBe(true); // the transport's open packet
    expect(open.headers['x-content-type-options']).toBe('nosniff');
    expect(open.headers['strict-transport-security']).toBe(HSTS);
    const sid = JSON.parse(open.body.slice(1)).sid as string;
    const poll = await request(fixture.port, `/socket.io/?EIO=4&transport=polling&sid=${sid}`, 'POST', {
      body: '40',
      contentType: 'text/plain;charset=UTF-8',
    });
    expect(poll.status).toBe(200);
    expect(poll.headers['x-content-type-options']).toBe('nosniff');
    expect(poll.headers['strict-transport-security']).toBe(HSTS);

    // The transport's own refusal (an unknown transport): engine.io answers 400 synchronously, inside
    // its own request listener — a hook registered behind that listener arrives after the headers.
    const refused = await request(fixture.port, '/socket.io/?EIO=4&transport=carrier-pigeon');
    expect(refused.status).toBe(400);
    expect(refused.headers['x-content-type-options']).toBe('nosniff');
    expect(refused.headers['strict-transport-security']).toBe(HSTS);

    // The client script socket.io serves itself: a script, the class nosniff exists for.
    const script = await request(fixture.port, '/socket.io/socket.io.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
    expect(script.headers['x-content-type-options']).toBe('nosniff');
    expect(script.headers['strict-transport-security']).toBe(HSTS);

    // Over plain http the transport still answers (the edge redirects before a pod sees plain http):
    // nosniff rides, Strict-Transport-Security does not (a browser ignores it there).
    const plain = await request(fixture.port, '/socket.io/?EIO=4&transport=polling', 'GET', { forwardedHttps: false });
    expect(plain.status).toBe(200);
    expect(plain.headers['x-content-type-options']).toBe('nosniff');
    expect(plain.headers['strict-transport-security']).toBeUndefined();

    // The WebSocket upgrade: a 101 written on the raw socket, no http response at all — the headers
    // ride it through the transport's own headers hook.
    const upgrade = await upgradeResponse(fixture.port, '/socket.io/?EIO=4&transport=websocket');
    expect(upgrade.status).toBe(101);
    expect(upgrade.headers.upgrade).toBe('websocket');
    expect(upgrade.headers['strict-transport-security']).toBe(HSTS);
    expect(upgrade.headers['x-content-type-options']).toBe('nosniff');
  }, 30000);

  it("a browser's violation report posted to /csp-report is answered 204 and logged as one line — the directive and the blocked origin, the page's url redacted", async () => {
    fixture = await startFixture({ FIXTURE_ORIGIN: ORIGIN, FIXTURE_PAGES: JSON.stringify(DECLARED_PAGES) });

    const report = {
      'csp-report': {
        'document-uri': `${ORIGIN}/login/password-reset?token=the-live-token`,
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
        'blocked-uri': 'https://cdn.evil.example/x.js?k=the-value',
        disposition: 'report',
      },
    };
    const answer = await request(fixture.port, '/csp-report', 'POST', {
      body: JSON.stringify(report),
      contentType: 'application/csp-report',
    });
    expect(answer.status).toBe(204);

    // The one WARN line and the object the log writer prints under it.
    const logged = await fixture.outputFrom(/Content Security Policy violation reported/);
    expect(logged).toContain('script-src');
    expect(logged).toContain('https://cdn.evil.example/x.js?k=<redacted>');
    expect(logged).toContain('/login/password-reset?token=<redacted>');
    // Neither value reaches the process's output anywhere.
    expect(fixture.output()).not.toContain('the-live-token');
    expect(fixture.output()).not.toContain('the-value');

    // The door stands ahead of the session: a report that carries the visitor's session cookie reads
    // no session (anyone can post here), where the same cookie on a page does.
    const cookie = String((await request(fixture.port, '/session-cookie')).headers['set-cookie']?.[0]).split(';')[0];
    const output = fixture.output;
    const sessionReads = () => output().split('SESSION_READ_METADATA').length - 1;
    await request(fixture.port, '/plain-page', 'GET', { cookie });
    const readsBeforeReport = sessionReads();
    expect(readsBeforeReport).toBeGreaterThan(0);
    const withCookie = await request(fixture.port, '/csp-report', 'POST', {
      body: JSON.stringify(report),
      contentType: 'application/csp-report',
      cookie,
    });
    expect(withCookie.status).toBe(204);
    expect(sessionReads()).toBe(readsBeforeReport);
  }, 30000);

  it('an enforced policy rides the one Content-Security-Policy header beside the framing refusal, reporting to the same door', async () => {
    const pages = {
      ...DECLARED_PAGES,
      contentSecurityPolicy: { ...DECLARED_PAGES.contentSecurityPolicy, reportOnly: false },
    };
    fixture = await startFixture({ FIXTURE_ORIGIN: ORIGIN, FIXTURE_PAGES: JSON.stringify(pages) });

    const page = await request(fixture.port, '/plain-page');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toBe(`${REFUSES_FRAMING}; ${DECLARED_CSP}`);
    expect(page.headers['content-security-policy-report-only']).toBeUndefined();
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
    fixture = await startFixture({
      FIXTURE_PAGES: JSON.stringify({ frameAncestors: ['https://www.example.com', 'https://embed.example.org:8443'] }),
    });

    const page = await request(fixture.port, '/frameable-page');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' https://www.example.com https://embed.example.org:8443"
    );
    // X-Frame-Options has no value for a cross-origin list (ALLOW-FROM is dead): omitted, so the
    // one header a browser without frame-ancestors support would read does not refuse the framer
    // the deployment allowed. Every browser with frame-ancestors ignores X-Frame-Options anyway.
    expect(page.headers['x-frame-options']).toBeUndefined();

    for (const undeclared of ['/', '/plain-page']) {
      const other = await request(fixture.port, undeclared);
      expect(other.headers['content-security-policy']).toBe(REFUSES_FRAMING);
      expect(other.headers['x-frame-options']).toBe('DENY');
    }
  }, 30000);

  it('a declaration the server cannot send as written refuses to boot, naming it — never a header or a Location a browser would misread', async () => {
    const refused: Array<{ env: NodeJS.ProcessEnv; names: string[] }> = [
      // A frame ancestor that is not an origin.
      {
        env: { FIXTURE_PAGES: JSON.stringify({ frameAncestors: ['https://www.example.com/embed'] }) },
        names: ['https://www.example.com/embed', 'frameAncestors'],
      },
      // The framing directive inside the declared policy: the route's declaration, never a directive.
      {
        env: {
          FIXTURE_PAGES: JSON.stringify({
            contentSecurityPolicy: { reportOnly: true, directives: { 'frame-ancestors': ["'none'"] } },
          }),
        },
        names: ['frame-ancestors', 'Route.frameable'],
      },
      // An origin with a trailing slash: a Location built from it is not the origin written.
      {
        env: { FIXTURE_ORIGIN: 'https://app.example.com/' },
        names: ['https://app.example.com/', 'ServerConfig.origin'],
      },
      // A plain-http origin outside development: the redirect would send every request back to http.
      { env: { FIXTURE_ORIGIN: 'http://app.example.com' }, names: ['http://app.example.com', 'https origin'] },
    ];
    for (const { env, names } of refused) {
      const boot = await bootOutcome(env);
      if (boot.ready) {
        await stop(boot.fixture); // a server that booted on a bad declaration is the failure
      }
      expect(boot.ready).toBe(false);
      for (const name of names) {
        expect(boot.output).toContain(name);
      }
    }
  }, 60000);
});

type Fixture = {
  child: ChildProcess;
  port: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** The process's output so far (stdout and stderr). */
  output: () => string;
  /** The output from the first line matching `pattern` (so far, or within 5 s) to its end. */
  outputFrom: (pattern: RegExp) => Promise<string>;
};

async function stop(fixture: Fixture | undefined): Promise<void> {
  if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
    fixture.child.kill('SIGKILL');
    await fixture.exited.catch(() => undefined);
  }
}

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
  // behavior must come from its own config only — DEVELOPMENT in particular would drop the prod
  // shape (trust proxy, the https redirect) these suites assert.
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
  const outputFrom = async (pattern: RegExp): Promise<string> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const match = pattern.exec(output);
      if (match) {
        // The log writer prints a line's object under it: everything from the matched line on, settled.
        await sleep(100);
        return output.slice(output.lastIndexOf('\n', match.index) + 1);
      }
      if (Date.now() > deadline) {
        throw new Error(`no output matched ${pattern}; output:\n${output}`);
      }
      await sleep(50);
    }
  };
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { ready: false, output };
    }
    const result = await request(port, '/health-check').catch(() => undefined);
    if (result?.status === 200) {
      return { ready: true, fixture: { child, port, exited, output: () => output, outputFrom }, output };
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      await exited.catch(() => undefined);
      return { ready: false, output: `(timed out)\n${output}` };
    }
    await sleep(100);
  }
}

/**
 * One request on its OWN connection (agent: false — no keep-alive pooling). The forwarded proto is
 * the LB topology in miniature: a request marked https is served, a plain one (forwardedHttps: false)
 * meets the https redirect. `host` is the Host header the request carries, `cookie` its Cookie.
 */
function request(
  port: number,
  requestPath: string,
  method: 'GET' | 'POST' = 'GET',
  options: { forwardedHttps?: boolean; host?: string; body?: string; contentType?: string; cookie?: string } = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const body = options.body ?? '';
  const headers: http.OutgoingHttpHeaders = { 'Content-Length': Buffer.byteLength(body) };
  if (options.forwardedHttps !== false) {
    headers['X-Forwarded-Proto'] = 'https';
  }
  if (options.host) {
    headers.Host = options.host;
  }
  if (options.contentType) {
    headers['Content-Type'] = options.contentType;
  }
  if (options.cookie) {
    headers.Cookie = options.cookie;
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, agent: false, headers }, (res) => {
      let answer = '';
      res.on('data', (chunk) => (answer += String(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: answer, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * A WebSocket upgrade request (forwarded as https, like every request from the load balancer): the
 * status and headers of the server's answer — the 101 the transport writes on the raw socket, or an
 * ordinary response when it refuses. The socket is dropped the moment the headers are read.
 */
function upgradeResponse(
  port: number,
  requestPath: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: 'GET',
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'X-Forwarded-Proto': 'https',
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
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
