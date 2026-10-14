import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import * as zlib from 'zlib';
import { ChildProcess, spawn } from 'child_process';

/**
 * RESPONSE COMPRESSION, on a real server process (spawns the built dist — run `npm run build`
 * first). A response composed in full — its Content-Length known when its headers go out — of a
 * compressible type is encoded as the client's Accept-Encoding asks (gzip, deflate or brotli), from
 * the threshold up; a large JSON answer crosses the wire at a fraction of its size. A streamed
 * response (no length declared, pieces written as they are ready) is never encoded: its pieces
 * arrive as they are written. The realtime transport's path never reaches the application.
 *
 * Asserted through the front door: the bytes that crossed the socket, the headers, and the body
 * decoded back to what the route composed.
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');

const DOCUMENT_BYTES = 2_600_000;

type Fixture = { child: ChildProcess; port: number; exited: Promise<unknown> };
type Answer = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  wireBytes: number;
  firstChunkAfterMs: number;
  lastChunkAfterMs: number;
};

describe('a response composed in full', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startFixture();
  }, 30000);

  afterAll(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited;
    }
  });

  it('with no Accept-Encoding: the body as composed, its length declared', async () => {
    const answer = await get(fixture.port, `/big-body-route?bytes=${DOCUMENT_BYTES}`, {});
    expect(answer.status).toBe(200);
    expect(answer.headers['content-encoding']).toBeUndefined();
    expect(Number(answer.headers['content-length'])).toBe(answer.body.length);
    expect(answer.body.length).toBeGreaterThanOrEqual(DOCUMENT_BYTES);
    expect(answer.wireBytes).toBe(answer.body.length);
  }, 30000);

  it('a 2.6 MB JSON answer under gzip: encoded, a fraction of its size on the wire, decoded to the same bytes', async () => {
    const plain = await get(fixture.port, `/big-body-route?bytes=${DOCUMENT_BYTES}`, {});
    const answer = await get(fixture.port, `/big-body-route?bytes=${DOCUMENT_BYTES}`, { 'Accept-Encoding': 'gzip' });
    expect(answer.status).toBe(200);
    expect(answer.headers['content-encoding']).toBe('gzip');
    expect(answer.headers.vary).toContain('Accept-Encoding');
    expect(answer.wireBytes).toBeLessThan(plain.body.length / 5);
    expect(zlib.gunzipSync(answer.body).equals(plain.body)).toBe(true);
  }, 30000);

  it('the same answer under brotli: encoded as asked, decoded to the same bytes', async () => {
    const plain = await get(fixture.port, `/big-body-route?bytes=${DOCUMENT_BYTES}`, {});
    const answer = await get(fixture.port, `/big-body-route?bytes=${DOCUMENT_BYTES}`, { 'Accept-Encoding': 'br' });
    expect(answer.status).toBe(200);
    expect(answer.headers['content-encoding']).toBe('br');
    expect(answer.wireBytes).toBeLessThan(plain.body.length / 5);
    expect(zlib.brotliDecompressSync(answer.body).equals(plain.body)).toBe(true);
  }, 30000);

  it("a browser's Accept-Encoding (gzip, deflate, br): one of the encodings it named", async () => {
    const answer = await get(fixture.port, `/big-body-route?bytes=${DOCUMENT_BYTES}`, {
      'Accept-Encoding': 'gzip, deflate, br',
    });
    expect(['gzip', 'br', 'deflate']).toContain(answer.headers['content-encoding']);
  }, 30000);

  it('a small answer stays as it is: under the threshold the framing would not pay for itself', async () => {
    const answer = await get(fixture.port, '/served', { 'Accept-Encoding': 'gzip' });
    expect(answer.status).toBe(200);
    expect(answer.body.toString('utf8')).toBe('served');
    expect(answer.headers['content-encoding']).toBeUndefined();
  });
});

describe('what is never encoded', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startFixture();
  }, 30000);

  afterAll(async () => {
    if (fixture && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill('SIGKILL');
      await fixture.exited;
    }
  });

  it('a streamed response: no encoding, and its first piece arrives before its last is written', async () => {
    const answer = await get(fixture.port, '/streamed-route', { 'Accept-Encoding': 'gzip, deflate, br' });
    expect(answer.status).toBe(200);
    expect(answer.headers['content-encoding']).toBeUndefined();
    expect(answer.headers['transfer-encoding']).toBe('chunked');
    const pieces = answer.body
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).piece);
    expect(pieces).toEqual([1, 2, 3]);
    // The route writes its last piece 400 ms after its first: an encoder holding the pieces would
    // deliver them together at the end.
    expect(answer.firstChunkAfterMs).toBeLessThan(answer.lastChunkAfterMs - 150);
  });

  it("the realtime transport's path: the application never sees it — no request id, no encoding", async () => {
    const answer = await get(fixture.port, '/socket.io/?EIO=4&transport=polling', {
      'Accept-Encoding': 'gzip, deflate, br',
    });
    expect(answer.headers['x-request-id']).toBeUndefined();
    expect(answer.headers['content-encoding']).toBeUndefined();
    // The positive control: a routed request on the same process carries the id.
    const routed = await get(fixture.port, '/slow-route?ms=1', {});
    expect(routed.headers['x-request-id']).toMatch(/^[0-9a-f]{16}$/);
  });
});

/** One GET over a real socket: the headers, the body's bytes, the bytes that crossed the wire, and when the pieces arrived. */
function get(port: number, requestPath: string, headers: { [name: string]: string }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    // The forwarded proto clears the https redirect the served shape applies in front of routes.
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: 'GET',
        agent: false,
        headers: { 'X-Forwarded-Proto': 'https', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let firstChunkAfterMs = -1;
        let lastChunkAfterMs = -1;
        res.on('data', (chunk: Buffer) => {
          if (firstChunkAfterMs < 0) {
            firstChunkAfterMs = Date.now() - startedAt;
          }
          lastChunkAfterMs = Date.now() - startedAt;
          chunks.push(chunk);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            wireBytes: body.length,
            firstChunkAfterMs,
            lastChunkAfterMs,
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
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
      return { child, port, exited };
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
