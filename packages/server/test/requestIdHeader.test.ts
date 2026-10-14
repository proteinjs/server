import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * THE REQUEST ID IS ECHOED ON THE RESPONSE (a real server process — spawns the built dist; run
 * `npm run build` first). The server mints an id per routed request and carries it on every log
 * line the request writes; echoed as `X-Request-Id`, the lines a load balancer writes about the
 * request, this process's Started/Finished pair and a route's own lines join on one id. The
 * Finished line carries the request's whole time on the process and the status it answered.
 *
 * Asserted through the front door: the header against the id the fixture prints off the request's
 * metadata, and the lines on the process's stdout.
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

describe('the request id on the response', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
  });

  it("X-Request-Id is the id the request's own metadata carries, fresh per request", async () => {
    fixture = await startFixture();

    const first = await request(fixture.port, '/some-page', { 'X-Forwarded-Proto': 'https' });
    await fixture.waitForLine(/REQUEST_METADATA_ID \/some-page /m);
    const second = await request(fixture.port, '/some-page', { 'X-Forwarded-Proto': 'https' });
    await fixture.waitForLine(
      /REQUEST_METADATA_ID \/some-page [0-9a-f]{16}\n(.*\n)*.*REQUEST_METADATA_ID \/some-page /m
    );

    const ids = metadataIds(fixture.stdout(), '/some-page');
    expect(ids).toHaveLength(2);
    expect(first.headers['x-request-id']).toBe(ids[0]);
    expect(second.headers['x-request-id']).toBe(ids[1]);
    expect(ids[0]).not.toBe(ids[1]);
  }, 30000);

  it('the Finished line carries the duration and the status', async () => {
    fixture = await startFixture();

    const page = await request(fixture.port, '/slow-route?ms=300', { 'X-Forwarded-Proto': 'https' });
    expect(page.status).toBe(200);
    await fixture.waitForLine(/Finished \/slow-route\?ms=<redacted>/m);

    // The dev writer prints the message, then the line's object (in color: the escapes stripped here).
    const log = fixture.stdout().replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
    const finished = log.indexOf('Finished /slow-route?ms=<redacted>');
    expect(finished).toBeGreaterThan(-1);
    const after = log.slice(finished, finished + 400);
    const duration = after.match(/durationMs: (\d+)/);
    expect(duration).not.toBeNull();
    expect(Number(duration![1])).toBeGreaterThanOrEqual(300);
    expect(after).toMatch(/status: 200/);
  }, 30000);
});

/** The ids the fixture printed off the request metadata for `requestPath`, in order. */
function metadataIds(log: string, requestPath: string): string[] {
  const ids: string[] = [];
  const pattern = new RegExp(`^REQUEST_METADATA_ID ${requestPath.replace(/\//g, '\\/')} ([0-9a-f]{16})$`, 'gm');
  for (let match = pattern.exec(log); match !== null; match = pattern.exec(log)) {
    ids.push(match[1]);
  }
  return ids;
}

function request(port: number, requestPath: string, headers: { [name: string]: string }) {
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
