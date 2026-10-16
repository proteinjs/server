import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * A REQUEST THAT FAILS OUTSIDE ITS ROUTE IS ANSWERED, AND THE PROCESS LIVES (a real server process —
 * spawns the built dist; run `npm run build` first). Every routed request first builds its session
 * context: each registered SessionDataCache's `create` runs in `wrapRoute`, in front of the route
 * and outside the route's own try/catch. A cache's rejection there — a session's account row the
 * db layer could not read, say — used to escape the async handler express never awaits, reach the
 * process as an unhandled rejection (the fatal boundary: exit 1, every in-flight request on the
 * process with it) and leave the request hanging. The boundary `wrapRoute` now holds: the request
 * is answered 500 and the failure is logged against the request id its response header carries.
 *
 * Asserted through the front door: the fixture's cache (`fixture-session-cache`) rejects while
 * armed; a routed request while armed answers 500 with its X-Request-Id, a request after it is
 * served, the process never exited, and the log line names the cache and the id.
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');

type Fixture = {
  child: ChildProcess;
  port: number;
  stdout: () => string;
  waitForLine: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  exited: Promise<unknown>;
};

describe('a request whose session cache fails to build', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
  });

  it('is answered 500 under its own request id, the next request is served, and the process lives', async () => {
    fixture = await startFixture();
    const armed = await request(fixture.port, '/arm-session-cache-failure');
    expect(armed.status).toBe(200);

    const failed = await request(fixture.port, '/some-page', { 'X-Forwarded-Proto': 'https' });
    expect(failed.status).toBe(500);
    const requestId = failed.headers['x-request-id'];
    expect(requestId).toMatch(/^[0-9a-f]{16}$/);
    await fixture.waitForLine(/Request failed outside its route — answering 500/m);

    // The line names the cache and carries the request id the response's header echoed.
    const log = fixture.stdout().replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
    const failedAt = log.indexOf('Request failed outside its route — answering 500');
    const after = log.slice(failedAt, failedAt + 1200);
    expect(after).toMatch(new RegExp(`id: '${requestId}'`));
    expect(after).toContain("Session data cache 'fixture-session-cache' failed to build");

    expect(fixture.child.exitCode).toBeNull();
    expect(fixture.child.signalCode).toBeNull();
    expect(log).not.toContain('exiting 1');

    const disarmed = await request(fixture.port, '/disarm-session-cache-failure');
    expect(disarmed.status).toBe(200);
    const served = await request(fixture.port, '/slow-route?ms=1', { 'X-Forwarded-Proto': 'https' });
    expect(served.status).toBe(200);
  }, 30000);
});

function request(port: number, requestPath: string, headers: { [name: string]: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: requestPath, agent: false, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      })
      .on('error', reject);
  });
}

async function startFixture(): Promise<Fixture> {
  const port = await ephemeralPort();
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
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const waitForLine = async (pattern: RegExp, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(output)) {
      if (Date.now() > deadline) {
        throw new Error(`Never saw ${pattern} in the fixture's output:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Fixture exited during boot; output:\n${output}`);
    }
    const ready = await new Promise<boolean>((resolve) => {
      http
        .get({ host: '127.0.0.1', port, path: '/health-check', agent: false }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        })
        .on('error', () => resolve(false));
    });
    if (ready) {
      return { child, port, stdout: () => output, waitForLine, exited };
    }
    if (Date.now() > deadline) {
      throw new Error(`Fixture never became ready; output:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
