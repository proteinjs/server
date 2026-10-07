import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * A failed boot ends the process (spawns the built dist — run `npm run build` first). A `before
 * server config` startup task that rejects — a schema sync the database refused — makes
 * `startServer` exit 1 with the error on one line, and nothing ever listens. Pinned in BOTH of
 * Node's --unhandled-rejections modes:
 *   throw — the default: an unhandled rejection is fatal anyway (GracefulShutdown's fatal-error
 *           boundary), so the exit held before; the LINE is the contract here;
 *   warn  — a dev supervisor's launch flag: a consumer's bare `startServer(config)` call used to
 *           leave the rejection as a warning and the process idling with no listener and no exit.
 * The boot is awaited by `startServer` itself, so the mode no longer decides.
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'bootFailureServer.js');
const EXIT_BOUND_MS = 15_000;

describe('a failed boot exits 1 and never listens', () => {
  let child: ChildProcess | undefined;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited?.catch(() => undefined);
    }
    child = undefined;
  });

  it.each(['warn', 'throw'] as const)(
    '--unhandled-rejections=%s: exit 1 within the bound, the error on one line through the logger, the port never opened',
    async (mode) => {
      const port = await ephemeralPort();
      // Scrub the env vars startServer reads (dev machines export some of these): the fixture's
      // behavior must come from its own config only.
      const env = { ...process.env };
      delete env.SERVER_PORT;
      delete env.DEVELOPMENT;
      delete env.DISABLE_HOT_CLIENT_BUILDS;
      delete env.HMR_PORT;
      delete env.NODE_OPTIONS;
      child = spawn(process.execPath, [`--unhandled-rejections=${mode}`, fixturePath], {
        cwd: packageRoot,
        env: { ...env, FIXTURE_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout!.on('data', (chunk) => (output += String(chunk)));
      child.stderr!.on('data', (chunk) => (output += String(chunk)));
      exited = new Promise((resolve) => child!.once('exit', (code, signal) => resolve({ code, signal })));

      const outcome = await Promise.race([exited, sleep(EXIT_BOUND_MS).then(() => 'still running' as const)]);
      // The hang: no listener, no exit — the process idles (its database client's channel holding the loop) under
      // the supervisor forever.
      expect(outcome).not.toBe('still running');
      expect(outcome).toEqual({ code: 1, signal: null });
      // The failure is REPORTED on one line, with the error's own words, through the logger.
      const line = output.split('\n').find((candidate) => candidate.includes('Boot failed — exiting 1'));
      expect(line).toBeDefined();
      expect(line).toContain('Boot failed — exiting 1: 9 FAILED_PRECONDITION: Duplicate name in schema: example_table');
      // Nothing listened: the steps ahead of the listener never resolved.
      expect(output).not.toContain('FIXTURE_LISTENING');
      expect(output).not.toContain('Server listening on port');
      await expect(connect(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    },
    EXIT_BOUND_MS + 15_000
  );
});

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

function connect(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
