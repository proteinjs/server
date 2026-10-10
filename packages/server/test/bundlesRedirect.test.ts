import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * A REAL server process (the built dist — run `npm run build` first) with a declared bundles URL,
 * asserted through the front door:
 *
 *  1. its own bundles path, `/static/<bundlesDir>/…`, answers a permanent redirect (308) to the
 *     same file at the declared place — a page served before the bundles moved, or a stale copy
 *     of one, still reaches its chunks; the rest of `/static/` is served from disk as before;
 *  2. the page it ships names the bundles at the declared place, in CORS mode;
 *  3. without a declaration the same static dir serves its bundles itself (the default road);
 *  4. a declaration that is not an absolute http(s) URL refuses the boot by name — the process
 *     exits non-zero instead of serving pages that name a place no browser can load.
 *
 * Pre-fix red: 1 answers 200 from disk, 2 names `/static/bundles/…`, 4 boots and serves.
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');
const BUNDLES_URL = 'https://assets.example.com/bundles';

describe('a declared bundles URL on a real server', () => {
  let fixture: Fixture | undefined;
  let staticDir: string;
  const pixel = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  beforeEach(() => {
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundles-redirect-'));
    fs.mkdirSync(path.join(staticDir, 'bundles'));
    fs.mkdirSync(path.join(staticDir, 'images'));
    fs.writeFileSync(path.join(staticDir, 'bundles', 'app.test.js'), "console.log('app');\n");
    fs.writeFileSync(path.join(staticDir, 'images', 'pixel.png'), pixel);
  });

  afterEach(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited.catch(() => undefined);
    }
    fixture = undefined;
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  it('answers its own bundles path with a permanent redirect to the declared place; the rest of /static/ is served from disk', async () => {
    fixture = await startFixture({ FIXTURE_STATIC_DIR: staticDir, FIXTURE_BUNDLES_URL: BUNDLES_URL });

    const bundle = await request(fixture.port, '/static/bundles/app.test.js?v=1');
    expect(bundle.status).toBe(308);
    expect(bundle.headers.location).toBe(`${BUNDLES_URL}/app.test.js`);

    const image = await request(fixture.port, '/static/images/pixel.png');
    expect(image.status).toBe(200);
    expect(image.body.equals(pixel)).toBe(true);
  }, 30000);

  it('ships a page that names the bundles at the declared place, in CORS mode', async () => {
    fixture = await startFixture({ FIXTURE_STATIC_DIR: staticDir, FIXTURE_BUNDLES_URL: BUNDLES_URL });

    const page = await request(fixture.port, '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body.toString()).toContain(
      `<script defer src='${BUNDLES_URL}/app.test.js' crossorigin='anonymous'></script>`
    );
    expect(page.body.toString()).not.toContain('/static/bundles/');
  }, 30000);

  it('serves the bundles itself when nothing is declared — the default road', async () => {
    fixture = await startFixture({ FIXTURE_STATIC_DIR: staticDir });

    const bundle = await request(fixture.port, '/static/bundles/app.test.js');
    expect(bundle.status).toBe(200);
    expect(bundle.body.toString()).toBe("console.log('app');\n");
    const page = await request(fixture.port, '/');
    expect(page.body.toString()).toContain("<script defer src='/static/bundles/app.test.js'></script>");
  }, 30000);

  it('refuses to boot on a declaration that is not an absolute http(s) URL, naming the field', async () => {
    const { exited, output } = await bootToExit({
      FIXTURE_STATIC_DIR: staticDir,
      FIXTURE_BUNDLES_URL: 'assets.example.com/bundles',
    });
    expect(exited.code).not.toBe(0);
    expect(output).toMatch(/staticContent\.bundlesUrl/);
  }, 30000);
});

type Fixture = {
  child: ChildProcess;
  port: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function spawnFixture(port: number, extraEnv: Record<string, string>) {
  // Scrub the env vars startServer reads (dev machines export some of these): the fixture's
  // behavior must come from its own config only.
  const env = { ...process.env };
  delete env.SERVER_PORT;
  delete env.DEVELOPMENT;
  delete env.DISABLE_HOT_CLIENT_BUILDS;
  delete env.HMR_PORT;
  const child = spawn(process.execPath, [fixturePath], {
    cwd: packageRoot,
    env: { ...env, FIXTURE_PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (chunk) => (output += String(chunk)));
  child.stderr!.on('data', (chunk) => (output += String(chunk)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  );
  return { child, exited, output: () => output };
}

async function startFixture(extraEnv: Record<string, string>): Promise<Fixture> {
  const port = await ephemeralPort();
  const { child, exited, output } = spawnFixture(port, extraEnv);
  // Ready = the health check answers 200 (readiness through the front door, not log lines).
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Fixture exited during boot; output:\n${output()}`);
    }
    const result = await request(port, '/health-check').catch(() => undefined);
    if (result?.status === 200) {
      return { child, port, exited };
    }
    if (Date.now() > deadline) {
      throw new Error(`Fixture never became ready; output:\n${output()}`);
    }
    await sleep(100);
  }
}

/** Boots the fixture and waits for it to EXIT (a refused boot), bounded; a fixture that serves instead is killed and reported. */
async function bootToExit(extraEnv: Record<string, string>) {
  const port = await ephemeralPort();
  const { child, exited, output } = spawnFixture(port, extraEnv);
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { exited: await exited, output: output() };
    }
    const result = await request(port, '/health-check').catch(() => undefined);
    if (result?.status === 200 || Date.now() > deadline) {
      child.kill('SIGKILL');
      await exited.catch(() => undefined);
      return { exited: { code: 0, signal: null }, output: `the fixture served instead of refusing:\n${output()}` };
    }
    await sleep(100);
  }
}

/** One request on its OWN connection; the forwarded proto is the LB topology in miniature. */
function request(
  port: number,
  requestPath: string
): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: requestPath, agent: false, headers: { 'X-Forwarded-Proto': 'https' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers })
        );
        res.on('error', reject);
      }
    );
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
