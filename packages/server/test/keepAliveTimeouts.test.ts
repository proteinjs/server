import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * Keep-alive timeout contract of a real server process (spawns the built dist — run
 * `npm run build` first). The constraint these tests pin down:
 *
 * The load balancer in front of this server reuses idle backend connections for up to its idle
 * timeout (GCP-documented: 600s). The backend's keep-alive MUST outlive that — with Node's
 * default keepAliveTimeout (5s), the server closes an idle connection at the same moment the LB
 * reuses it and the request dies as a 502 (backend_connection_closed_before_data_sent_to_client;
 * log-proven prod incident 2026-08-15). Node additionally requires headersTimeout to exceed
 * keepAliveTimeout, or the same race re-opens on header parsing.
 *
 * Asserted through the front door on the LIVE instance (/server-timeouts reads the running
 * http.Server off the request socket), plus the behavioral outcome: an idle keep-alive
 * connection survives past Node's 5s default and still serves a reused request — the exact
 * reuse the LB performs.
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');

/** The LB idle timeout the backend must exceed (GCP-documented: 600s). */
const LB_IDLE_TIMEOUT_MS = 600_000;

describe('keep-alive timeouts', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
  });

  it('the live server keeps idle connections longer than the LB idle timeout, with headersTimeout above keepAliveTimeout', async () => {
    fixture = await startFixture();
    const result = await request(fixture.port, '/server-timeouts');
    expect(result.status).toBe(200);
    const timeouts = JSON.parse(result.body) as { keepAliveTimeout: number; headersTimeout: number };
    // The constraint itself: backend keep-alive must OUTLIVE the LB's idle timeout, or idle-reuse
    // races close mid-request (the sporadic 502).
    expect(timeouts.keepAliveTimeout).toBeGreaterThan(LB_IDLE_TIMEOUT_MS);
    // Node's second race: headers of a reused connection must not be reaped by keep-alive.
    expect(timeouts.headersTimeout).toBeGreaterThan(timeouts.keepAliveTimeout);
  }, 30000);

  it('an idle keep-alive connection survives past the 5s Node default and still serves a reused request', async () => {
    fixture = await startFixture();

    // One raw keep-alive connection — the LB's idle backend connection, in miniature.
    const socket = net.connect({ host: '127.0.0.1', port: fixture.port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    let closed = false;
    socket.on('close', () => (closed = true));
    socket.on('error', () => undefined); // observed via `closed`, not as an unhandled event

    // First request establishes the connection as keep-alive.
    const first = await requestOnSocket(socket, fixture.port, '/health-check');
    expect(first.status).toBe(200);

    // Idle past Node's 5s default (the pre-fix server closes here — the 502 window).
    await sleep(6500);
    expect(closed).toBe(false);

    // The reuse itself: a request on the idled connection must complete, not die on a socket the
    // server already closed.
    const reused = await requestOnSocket(socket, fixture.port, '/health-check');
    expect(reused.status).toBe(200);

    socket.destroy();
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

/** One request on its OWN connection (agent: false — no keep-alive pooling). */
function request(port: number, requestPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath, agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += String(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/**
 * One HTTP/1.1 keep-alive request written RAW on an existing socket, resolved when the full
 * response (per Content-Length) has arrived — the connection stays open for reuse.
 */
function requestOnSocket(
  socket: net.Socket,
  port: number,
  requestPath: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let raw = '';
    const onData = (chunk: Buffer) => {
      raw += String(chunk);
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }
      const header = raw.slice(0, headerEnd);
      const contentLength = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
      const body = raw.slice(headerEnd + 4);
      if (Buffer.byteLength(body) < contentLength) {
        return;
      }
      cleanup();
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(header)?.[1] ?? 0);
      resolve({ status, body });
    };
    const onClose = () => {
      cleanup();
      reject(new Error('connection closed before the response completed'));
    };
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
    };
    socket.on('data', onData);
    socket.on('close', onClose);
    socket.write(
      `GET ${requestPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`,
      (error) => error && (cleanup(), reject(error))
    );
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
