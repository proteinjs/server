import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { RequestDigests } from '@proteinjs/util-node';

/**
 * A refused socket handshake leaves ONE line on the server — whoever refused it: the session gate
 * (a handshake with no signed-in session behind it) or the transport (an unknown or malformed
 * handshake). At WARN, never ERROR: a client's bad handshake is the client's, and an error-level
 * line would be reported and grouped as a server error. The line says why in the refuser's words
 * and which device by its coarse IP hash — never the client's address, never a cookie or a
 * session id — so an operator can count refusals per device.
 *
 * On a real server process (spawns the built dist — run `npm run build` first), driving the
 * socket transport's own wire protocol over plain HTTP (the long-polling transport), and reading
 * the process's output.
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');
/** The fixture's session secret: the digests on its lines are keyed like its sessions. */
const digests = new RequestDigests({ secret: 'graceful-shutdown-test' });
const WARN_COLOR = '\x1b[33m';
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

type Fixture = {
  child: ChildProcess;
  port: number;
  output: () => string;
  waitForLine: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

describe('a refused socket handshake leaves one WARN line with the device hash', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
  });

  it('a handshake with no session: refused Unauthorized, one WARN line naming the device by its hash', async () => {
    fixture = await startFixture();

    const answer = await connectWithoutSession(fixture.port);
    expect(answer).toBe('44{"message":"Unauthorized"}');
    await fixture.waitForLine(/Socket handshake refused/);

    const lines = refusalLines(fixture.output());
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(WARN_COLOR)).toBe(true);
    const plain = lines[0].replace(ANSI, '');
    expect(plain).toContain("reason: 'Unauthorized'");
    expect(plain).toContain(`device: '${digests.coarseIp('127.0.0.1')}'`);
    expect(plain).not.toContain('127.0.0.1');
    expect(plain).not.toMatch(/connect\.sid|sid/i);
  }, 30000);

  it('behind the load balancer the device is the client it appended, never the balancer or what the client claimed', async () => {
    fixture = await startFixture();

    await connectWithoutSession(fixture.port, { 'X-Forwarded-For': '203.0.113.9, 198.51.100.23, 34.120.1.1' });
    await fixture.waitForLine(/Socket handshake refused/);

    const plain = refusalLines(fixture.output())[0].replace(ANSI, '');
    expect(plain).toContain(`device: '${digests.coarseIp('198.51.100.23')}'`);
    expect(plain).not.toMatch(/198\.51\.100\.23|203\.0\.113\.9|34\.120\.1\.1/);
  }, 30000);

  it("the transport's own refusal (an unknown transport) is the same WARN line, with its code — no error-level line", async () => {
    fixture = await startFixture();

    const refused = await request(fixture.port, 'GET', '/socket.io/?EIO=4&transport=carrier-pigeon');
    expect(refused.status).toBe(400);
    await fixture.waitForLine(/Socket handshake refused/);

    const lines = refusalLines(fixture.output());
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(WARN_COLOR)).toBe(true);
    const plain = lines[0].replace(ANSI, '');
    expect(plain).toContain("reason: 'Transport unknown'");
    expect(plain).toContain('code: 0');
    expect(plain).toContain(`device: '${digests.coarseIp('127.0.0.1')}'`);
    expect(fixture.output()).not.toMatch(/Connection error/);
  }, 30000);
});

/** The lines the refusal writes (one write each), as the process wrote them. */
function refusalLines(output: string): string[] {
  return output.split(/\n(?=\S)/).filter((line) => line.includes('Socket handshake refused'));
}

/**
 * The socket transport's handshake over long-polling, carrying no session cookie: open the
 * transport, ask to join the default namespace, read the answer.
 */
async function connectWithoutSession(port: number, headers: Record<string, string> = {}): Promise<string> {
  const open = await request(port, 'GET', '/socket.io/?EIO=4&transport=polling', headers);
  expect(open.status).toBe(200);
  const sid = JSON.parse(open.body.slice(1)).sid as string;
  const join = await request(port, 'POST', `/socket.io/?EIO=4&transport=polling&sid=${sid}`, headers, '40');
  expect(join.status).toBe(200);
  const answer = await request(port, 'GET', `/socket.io/?EIO=4&transport=polling&sid=${sid}`, headers);
  return answer.body;
}

async function startFixture(): Promise<Fixture> {
  const port = await ephemeralPort();
  // Scrub the env vars startServer reads (dev machines export some of these): the fixture runs the
  // prod shape (trust proxy 1 — the load-balancer topology the device read depends on).
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
  const waitForLine = async (pattern: RegExp, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(output)) {
      if (Date.now() > deadline) {
        throw new Error(`No line matching ${pattern} within ${timeoutMs}ms; output:\n${output}`);
      }
      await sleep(50);
    }
  };
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Fixture exited during boot; output:\n${output}`);
    }
    const result = await request(port, 'GET', '/health-check').catch(() => undefined);
    if (result?.status === 200) {
      return { child, port, output: () => output, waitForLine, exited };
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
  method: 'GET' | 'POST',
  requestPath: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        agent: false,
        headers: body === undefined ? headers : { ...headers, 'Content-Type': 'text/plain;charset=UTF-8' },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += String(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(body);
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
