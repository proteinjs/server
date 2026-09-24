import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

/**
 * A ROUTE THAT DECLARES `rawBody` GETS THE BODY'S EXACT BYTES (a real server process — spawns the
 * built dist; run `npm run build` first). A webhook's signature is computed over the exact bytes it
 * sent, and the server's one JSON parser kept only the parsed body: re-serializing it changes the
 * bytes (whitespace, escapes, key order), so no signature could be verified. A route declares
 * `rawBody: true` and the same parser keeps the bytes it read beside the parsed body, readable with
 * `RawBody.of(request)` — for that route's requests only; every other route has none, and the body
 * limit refuses an oversized body the same way for both.
 *
 * Asserted through the front door: the fixture's two routes (`/raw-body-route` declares `rawBody`,
 * `/parsed-body-route` does not) answer with what the server kept for them.
 */
const packageRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixture', 'gracefulShutdownServer.js');

/** Unicode (two- to four-byte characters, an escape the parser decodes) and insignificant whitespace. */
const JSON_BODY = Buffer.from(
  '{ "customer" :  "Zoë Ångström",\n\t"note":"naïve — ✓ 🌍 \\u00e9",   "amount" : 4200 ,\r\n "tags":[ "a" ,"b" ] }\n',
  'utf8'
);
/** A form body: percent-escapes and a plus, which the parser decodes. */
const FORM_BODY = Buffer.from('customer=Zo%C3%AB+%C3%85ngstr%C3%B6m&note=na%C3%AFve+%E2%80%94&amount=4200', 'utf8');
/** One byte over the parser's limit (100mb). */
const OVER_THE_LIMIT_BYTES = 100 * 1024 * 1024 + 1;

type Fixture = { child: ChildProcess; port: number; exited: Promise<unknown> };
type Answer = { status: number; body: string };

describe('a route that declares rawBody', () => {
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

  it('receives the JSON body byte-identical to what was sent, beside the parsed body', async () => {
    const answer = await post(fixture.port, '/raw-body-route', 'application/json; charset=utf-8', JSON_BODY);

    expect(answer.status).toBe(200);
    const { rawBase64, parsed } = JSON.parse(answer.body);
    expect(Buffer.from(rawBase64, 'base64').equals(JSON_BODY)).toBe(true);
    expect(parsed).toEqual(JSON.parse(JSON_BODY.toString('utf8')));
  });

  it('receives a form body byte-identical too', async () => {
    const answer = await post(fixture.port, '/raw-body-route', 'application/x-www-form-urlencoded', FORM_BODY);

    expect(answer.status).toBe(200);
    const { rawBase64, parsed } = JSON.parse(answer.body);
    expect(Buffer.from(rawBase64, 'base64').equals(FORM_BODY)).toBe(true);
    expect(parsed).toEqual({ customer: 'Zoë Ångström', note: 'naïve —', amount: '4200' });
  });

  it('a route that does not declare it has no raw body — only the parsed one', async () => {
    const answer = await post(fixture.port, '/parsed-body-route', 'application/json; charset=utf-8', JSON_BODY);

    expect(answer.status).toBe(200);
    const { rawBase64, parsed } = JSON.parse(answer.body);
    expect(rawBase64).toBeNull();
    expect(parsed).toEqual(JSON.parse(JSON_BODY.toString('utf8')));
  });

  it('a body over the limit is refused the same way on both routes: 413, the route never runs', async () => {
    const declared = await postOverTheLimit(fixture.port, '/raw-body-route');
    const undeclared = await postOverTheLimit(fixture.port, '/parsed-body-route');

    expect(declared.status).toBe(413);
    expect(undeclared.status).toBe(413);
    expect(declared.body).toContain('request entity too large');
    expect(undeclared.body).toContain('request entity too large');
    // The routes answer JSON with a rawBase64 field; a refusal never reached them.
    expect(declared.body).not.toContain('rawBase64');
    expect(undeclared.body).not.toContain('rawBase64');
  }, 30000);
});

function post(port: number, requestPath: string, contentType: string, body: Buffer): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: 'POST',
        agent: false,
        // The forwarded proto clears the https redirect the served shape applies in front of routes.
        headers: { 'Content-Type': contentType, 'Content-Length': body.length, 'X-Forwarded-Proto': 'https' },
      },
      (res) => collect(res, resolve, reject)
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Sends a body one byte over the limit, streamed a megabyte at a time (never held whole). The parser
 * refuses on the declared length before reading a byte of it; the server answers once the request
 * has been drained, as it answers every refused body.
 */
function postOverTheLimit(port: number, requestPath: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': OVER_THE_LIMIT_BYTES,
          'X-Forwarded-Proto': 'https',
        },
      },
      (res) => collect(res, resolve, reject)
    );
    req.on('error', reject);
    const megabyte = Buffer.alloc(1024 * 1024, 0x20);
    let remaining = OVER_THE_LIMIT_BYTES;
    const writeMore = () => {
      while (remaining > 0) {
        const chunk = remaining >= megabyte.length ? megabyte : megabyte.subarray(0, remaining);
        remaining -= chunk.length;
        if (!req.write(chunk)) {
          req.once('drain', writeMore);
          return;
        }
      }
      req.end();
    };
    writeMore();
  });
}

function collect(res: http.IncomingMessage, resolve: (answer: Answer) => void, reject: (error: Error) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
  res.on('error', reject);
}

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
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // Ready = the health check answers 200 (readiness through the front door, not log lines).
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
