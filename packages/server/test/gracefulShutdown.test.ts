import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * Graceful-shutdown contract of a real server process (spawns the built dist — run
 * `npm run build` first). The exit-code/signal contract these tests pin down:
 *
 *   SIGTERM → readiness (/health-check) flips to 503 immediately while the listener stays
 *             open for shutdown.drainDelayMs (LBs observe the failing readiness and drain),
 *             then the listener closes (new connections refused), in-flight requests COMPLETE,
 *             idle keep-alives are closed, and the process exits 0 — bounded by
 *             shutdown.drainTimeoutMs (past it, remaining connections are force-closed and
 *             the exit is still 0).
 *   SIGINT  → immediate exit 0 (dev ctrl-C: fast, quiet).
 *   exit 86 → RESTART_REQUEST_EXIT_CODE, untouched by this feature: process.exit(86) is not
 *             signal-driven (ServePackageSupervisor's respawn contract rides it).
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');

type Fixture = {
  child: ChildProcess;
  port: number;
  stdout: () => string;
  waitForMarker: (marker: string, timeoutMs?: number) => Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

describe('graceful shutdown', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
  });

  it('SIGTERM: health flips to 503, in-flight request completes, new connections refused after the delay, exit 0 within the bound', async () => {
    // Generous drain delay so the 503 window is deterministic on slow CI runners.
    fixture = await startFixture({ drainDelayMs: 3000, drainTimeoutMs: 10000 });

    // Hold a request in flight (6s — longer than the 3s drain delay, well under the bound).
    const slow = request(fixture.port, '/slow?ms=6000');
    slow.catch(() => undefined); // an assertion failing earlier SIGKILLs the fixture — keep that teardown from surfacing as an unhandled rejection
    await fixture.waitForMarker('SLOW_REQUEST_STARTED');

    const sigtermAt = Date.now();
    fixture.child.kill('SIGTERM');

    // 1. Readiness fails IMMEDIATELY: a fresh connection inside the drain-delay window gets 503.
    const during = await request(fixture.port, '/health-check');
    expect(during.status).toBe(503);
    expect(Date.now() - sigtermAt).toBeLessThan(3000); // still inside the delay window

    // 2. After the delay the listener is closed: new connections are refused while the
    //    in-flight request is still draining.
    await sleep(sigtermAt + 4000 - Date.now());
    await expect(request(fixture.port, '/health-check')).rejects.toMatchObject({
      code: expect.stringMatching(/ECONNREFUSED|ECONNRESET/),
    });

    // 3. The in-flight request COMPLETES with its full response.
    const slowResult = await slow;
    expect(slowResult.status).toBe(200);
    expect(slowResult.body).toBe('slow-done');

    // 4. The process exits 0 shortly after the drain completes — the drain ended it, not the
    //    timeout (slow done at ~6s; bound would land at ~13s).
    const exit = await fixture.exited;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(Date.now() - sigtermAt).toBeLessThan(10000);
  }, 30000);

  it('SIGTERM: the drain is BOUNDED — a request longer than drainTimeoutMs is force-closed and the exit is still 0', async () => {
    fixture = await startFixture({ drainDelayMs: 0, drainTimeoutMs: 3000 });

    // In-flight request that would outlive the bound by far.
    const slow = request(fixture.port, '/slow?ms=60000').catch((e) => e);
    await fixture.waitForMarker('SLOW_REQUEST_STARTED');

    const sigtermAt = Date.now();
    fixture.child.kill('SIGTERM');

    const exit = await fixture.exited;
    expect(exit).toEqual({ code: 0, signal: null });
    const elapsed = Date.now() - sigtermAt;
    expect(elapsed).toBeGreaterThanOrEqual(3000); // the bound was actually served
    expect(elapsed).toBeLessThan(9000); // ...and it ended the drain, not the 60s request
    await slow; // the held request errored (socket destroyed) — surfaced, not leaked
  }, 30000);

  it('SIGINT: fast exit 0 (dev ctrl-C)', async () => {
    fixture = await startFixture({ drainDelayMs: 3000, drainTimeoutMs: 10000 });
    const sigintAt = Date.now();
    fixture.child.kill('SIGINT');
    const exit = await fixture.exited;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(Date.now() - sigintAt).toBeLessThan(2000); // no drain delay on the fast path
  }, 30000);
});

async function startFixture(shutdown: { drainDelayMs: number; drainTimeoutMs: number }): Promise<Fixture> {
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
    env: {
      ...env,
      FIXTURE_PORT: String(port),
      FIXTURE_DRAIN_DELAY_MS: String(shutdown.drainDelayMs),
      FIXTURE_DRAIN_TIMEOUT_MS: String(shutdown.drainTimeoutMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (chunk) => (output += String(chunk)));
  child.stderr!.on('data', (chunk) => (output += String(chunk)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  );
  const fixture: Fixture = {
    child,
    port,
    stdout: () => output,
    waitForMarker: async (marker: string, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      while (!output.includes(marker)) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for marker ${marker}; output so far:\n${output}`);
        }
        await sleep(50);
      }
    },
    exited,
  };
  // Ready = the health check answers 200 (readiness through the front door, not log lines).
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Fixture exited during boot; output:\n${output}`);
    }
    const result = await request(port, '/health-check').catch(() => undefined);
    if (result?.status === 200) {
      return fixture;
    }
    if (Date.now() > deadline) {
      throw new Error(`Fixture never became ready; output:\n${output}`);
    }
    await sleep(100);
  }
}

/** One request on its OWN connection (agent: false — no keep-alive pooling), so listener
 *  refusal after close is observable instead of masked by a pooled connection. */
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
