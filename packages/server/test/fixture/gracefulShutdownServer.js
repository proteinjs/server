/**
 * Test fixture: a REAL @proteinjs/server (the built dist — the same code prod runs) with a
 * deliberately slow endpoint, so the graceful-shutdown suite can hold a request in flight
 * while it signals the process. Run with:
 *   FIXTURE_PORT=<port> [FIXTURE_DRAIN_DELAY_MS=..] [FIXTURE_DRAIN_TIMEOUT_MS=..] [FIXTURE_TURN_DRAIN_MS=..] node gracefulShutdownServer.js
 *
 * Markers on stdout (the suite's synchronization points):
 *   FIXTURE_READY          — startServer resolved (the listener is up)
 *   SLOW_REQUEST_STARTED   — the /slow handler is executing (a request is now in flight)
 *   HOLD_ACQUIRED <label>  — /hold took a process hold (GracefulShutdown.hold) that outlives
 *                            its request: the response ends at once, the hold releases itself
 *                            ?ms= later — a detached chat turn's shape (no connection, work live)
 *   HOLD_RELEASED <label>  — that hold released
 *   REQUEST_METADATA_URL <url> — after a routed request, the url its request metadata carries: what
 *                            a consumer's log writer attaches to every line the request writes
 *   REQUEST_METADATA <path> #<number> <url> — the same read with the request's own path and the
 *                            metadata's number beside it
 *   SESSION_READ_METADATA <#number url | none> — the request metadata where the session store is
 *                            read: a line written BEFORE the routes (a request carrying a cookie)
 *   SOCKET_IO_CONNECTION_METADATA <#number url | none> — the request metadata where socket.io's
 *                            engine opens a connection: a polling request, which never reaches a route
 *   PARKED <path>          — /parked-page's dispatch is held; the next request whose query carries
 *                            `release` dispatches it from inside its own after-request seam — a
 *                            request dispatched from another request's lineage (a hand-off)
 *
 * Also serves /server-timeouts: the LIVE http.Server's keepAliveTimeout/headersTimeout (read off
 * the request's own socket), so the keep-alive suite asserts the running instance through the
 * front door instead of re-deriving values from source.
 *
 * Also serves the raw-body suite: POST /raw-body-route declares `rawBody`, POST /parsed-body-route
 * does not; each answers with the bytes the server kept for it (base64, or null) beside the parsed body.
 *
 * Also serves the local-strategy suite: /served, a route any request reaches (one carrying the
 * strategy's `username` + `password` fields included), and /local-strategy, a consumer route
 * driving the registered strategy the passport way (`passport.authenticate('local')`).
 *
 * Also serves the fatal-error suite: /crash?kind=exception|rejection answers 202, then fails in a
 * way nothing catches — an exception thrown outside any handler, or a rejected promise nothing
 * handles — with a CauseWithheldError whose cause's words carry FIXTURE_CRASH_CAUSE_VALUE.
 */
const { inspect } = require('util');
const expressSession = require('express-session');
const passport = require('passport');
const { SourceRepository } = require('@proteinjs/reflection');
const { RawBody } = require('@proteinjs/server-api');
const { startServer, GracefulShutdown, Request, SocketIOServerRepo } = require('../../dist/generated/index.js');

const port = Number(process.env.FIXTURE_PORT);
if (!port) {
  throw new Error('FIXTURE_PORT is required');
}

/**
 * A ROUTED slow endpoint: `GET /slow-route?ms=` holds for ?ms= inside a Route the server dispatches
 * through `wrapRoute` — so it gets the request log's Started/Finished pair, the request metadata
 * and the request timeout (`FIXTURE_REQUEST_TIMEOUT_MS` → ServerConfig.request.timeoutMs), which
 * the /slow seam below (a beforeRequest middleware, in front of every route) never reaches. Routes
 * are found by reflection, so the fixture registers this one the way the built dist registers its
 * own (dist/generated/index.js: a source-graph node typed `@proteinjs/server-api/Route` + the link
 * to the object, keyed by the qualified name `<package>/<name>`).
 */
const routeType = {
  packageName: '@proteinjs/server-api',
  name: 'Route',
  filePath: null,
  qualifiedName: '@proteinjs/server-api/Route',
  typeParameters: [],
  directParents: null,
};

/** Registers `route` under `@proteinjs/server/<name>` the way the built dist registers its own. */
function registerRoute(name, route) {
  const qualifiedName = `@proteinjs/server/${name}`;
  SourceRepository.merge(
    JSON.stringify({
      options: { directed: true, multigraph: false, compound: false },
      nodes: [
        {
          v: qualifiedName,
          value: {
            packageName: '@proteinjs/server',
            name,
            filePath: __filename,
            qualifiedName,
            type: { ...routeType, directParents: [routeType] },
            isExported: true,
            isConst: true,
            sourceType: 0,
          },
        },
        { v: routeType.qualifiedName },
      ],
      edges: [{ v: qualifiedName, w: routeType.qualifiedName, value: 'has type' }],
    }),
    { [qualifiedName]: route }
  );
}

registerRoute('slowRoute', {
  path: '/slow-route',
  method: 'get',
  onRequest: async (request, response) => {
    const ms = Number(request.query.ms ?? 3000);
    await new Promise((resolve) => setTimeout(resolve, ms));
    response.status(200).send('slow-route-done');
  },
});

/**
 * The raw-body suite's two routes, one declaring `rawBody` and one not: each answers with the bytes
 * the server kept for it (`RawBody.of`, base64 — null when none) beside the body it parsed.
 */
const echoBodies = async (request, response) => {
  const rawBody = RawBody.of(request);
  response.status(200).json({ rawBase64: rawBody ? rawBody.toString('base64') : null, parsed: request.body });
};
registerRoute('rawBodyRoute', { path: '/raw-body-route', method: 'post', rawBody: true, onRequest: echoBodies });
registerRoute('parsedBodyRoute', { path: '/parsed-body-route', method: 'post', onRequest: echoBodies });

/**
 * An error that withholds its cause when printed — the shape of a data-layer error whose backend
 * cause can quote a record's values: the cause rides non-enumerable for callers in process, and the
 * `util.inspect.custom` hook prints the error's own stack and names the cause as withheld.
 */
class CauseWithheldError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'CauseWithheldError';
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false, writable: false });
  }

  [inspect.custom]() {
    return `${this.stack} { cause: '<withheld: the backend error can quote record values>' }`;
  }
}

/** The request metadata a log writer would attach to a line written here, as a marker's text. */
function metadataHere() {
  const metadata = new Request().getMetadata();
  return metadata ? `#${metadata.number} ${metadata.url}` : 'none';
}

// The session store, read by the session middleware in front of every route for a request that
// carries a session cookie: a store that logs writes its lines here, before the request's route.
const sessionStore = new expressSession.MemoryStore();
const readSession = sessionStore.get.bind(sessionStore);
sessionStore.get = (sessionId, callback) => {
  console.log(`SESSION_READ_METADATA ${metadataHere()}`);
  readSession(sessionId, callback);
};

/** /parked-page's held dispatch (its beforeRequest `next`), until a `release` request runs it. */
let parkedDispatch;

startServer({
  port,
  session: { secret: 'graceful-shutdown-test', store: sessionStore },
  // The credential check every consumer configures, in the three shapes the local-strategy suite
  // drives: a right password passes, a wrong one is a failed check (the reason), and the name
  // `unavailable` is a check that fails outright (a rejection).
  authenticate: async (username, password) => {
    if (username === 'unavailable') {
      throw new Error('credential store unavailable');
    }
    return password === 'right' ? true : 'wrong password';
  },
  // Request logging stays ON — the served shape; the suites read their own markers off stdout.
  request: {
    // The request timeout, when a suite sets one (unset = the server's own default): the
    // request-logging suite fires it inside /slow-route to read the Timed-out line.
    timeoutMs: process.env.FIXTURE_REQUEST_TIMEOUT_MS ? Number(process.env.FIXTURE_REQUEST_TIMEOUT_MS) : undefined,
    // The slow endpoint rides the beforeRequest middleware seam so the fixture needs no
    // reflection-registered Route of its own: it answers /slow itself (never calls next)
    // after ?ms= of held work, standing in for any long in-flight request.
    beforeRequest: async (request, response, next) => {
      if (request.path === '/server-timeouts') {
        // The socket's `server` IS the live http.Server instance — the values the kernel-visible
        // connection actually runs under, not a copy of the config.
        const server = request.socket.server;
        response.status(200).json({ keepAliveTimeout: server.keepAliveTimeout, headersTimeout: server.headersTimeout });
        return;
      }
      if (request.path === '/session-cookie') {
        // Touch the session so express-session emits the Set-Cookie header (saveUninitialized is
        // false — an untouched session never sets a cookie); the session-cookie suite asserts the
        // attributes on the emitted cookie.
        request.session.probe = 'set';
        response.status(200).send('session-cookie-set');
        return;
      }
      if (request.path === '/hold') {
        // A hold that OUTLIVES its request — the detached-turn shape the drain must wait for:
        // the response ends now (no connection remains), the work stays live for ?ms=.
        const label = String(request.query.label ?? 'fixture-hold');
        const ms = Number(request.query.ms ?? 5000);
        const release = GracefulShutdown.hold(label, { source: 'fixture', ms });
        console.log(`HOLD_ACQUIRED ${label}`);
        setTimeout(() => {
          release();
          console.log(`HOLD_RELEASED ${label}`);
        }, ms);
        response.status(200).send('held');
        return;
      }
      if (request.path === '/served') {
        // A route like any other: the framework serves the request whatever fields it carries —
        // the route decides what credentials mean, if anything.
        response.status(200).send('served');
        return;
      }
      if (request.path === '/local-strategy') {
        // A consumer route driving the registered strategy the passport way: passport's own
        // answers (401 for a failed check, a session for a passed one, next(error) for a failing
        // one) are the contract.
        passport.authenticate('local')(request, response, (error) => {
          if (error) {
            next(error);
            return;
          }
          response.status(200).send(`logged in as ${request.user.username}`);
        });
        return;
      }
      if (request.path === '/crash') {
        // A failure nothing catches: ?kind=exception throws outside any handler (an uncaught
        // exception), ?kind=rejection rejects a promise nothing handles (an unhandled rejection).
        const cause = new Error(
          `backend refused the write: key ${process.env.FIXTURE_CRASH_CAUSE_VALUE} already exists`
        );
        const error = new CauseWithheldError('the statement failed (ALREADY_EXISTS)', cause);
        response.status(202).send('crashing');
        if (request.query.kind === 'rejection') {
          Promise.reject(error);
        } else {
          setImmediate(() => {
            throw error;
          });
        }
        return;
      }
      if (request.path === '/parked-page') {
        parkedDispatch = next;
        console.log('PARKED /parked-page');
        return;
      }
      if (request.path !== '/slow') {
        next();
        return;
      }
      console.log('SLOW_REQUEST_STARTED');
      const ms = Number(request.query.ms ?? 3000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      response.status(200).send('slow-done');
    },
    // A log writer's read of the request — the consumer's DefaultLogWriter attaches
    // `new Request().getMetadata()` to every line a request writes (the deployed writer prints its
    // url on each structured line); this seam runs inside the routed request's lineage, after it.
    afterRequest: async (request, response, next) => {
      if (request.query.release !== undefined && parkedDispatch) {
        // The hand-off: the parked request's dispatch runs from inside THIS request's lineage.
        const dispatch = parkedDispatch;
        parkedDispatch = undefined;
        dispatch();
      }
      const metadata = new Request().getMetadata();
      if (metadata) {
        console.log(`REQUEST_METADATA_URL ${metadata.url}`);
        // The request's own path beside the metadata's number and url: which request each read
        // belongs to, so a read that carries another request's metadata shows as a mismatch.
        console.log(`REQUEST_METADATA ${request.path} #${metadata.number} ${metadata.url}`);
      }
      next();
    },
  },
  // A bundle pointer so the '*' react-app route serves its HTML — the html-cache-control
  // suite asserts response headers on the page the app actually ships. No staticContentDir:
  // nothing needs the bundle to resolve, only the page response to render.
  staticContent: { bundlePaths: ['bundles/app.test.js'] },
  shutdown: {
    drainDelayMs: process.env.FIXTURE_DRAIN_DELAY_MS ? Number(process.env.FIXTURE_DRAIN_DELAY_MS) : undefined,
    drainTimeoutMs: process.env.FIXTURE_DRAIN_TIMEOUT_MS ? Number(process.env.FIXTURE_DRAIN_TIMEOUT_MS) : undefined,
    turnDrainMs: process.env.FIXTURE_TURN_DRAIN_MS ? Number(process.env.FIXTURE_TURN_DRAIN_MS) : undefined,
  },
}).then(() => {
  SocketIOServerRepo.getSocketIOServer().engine.on('connection', () => {
    console.log(`SOCKET_IO_CONNECTION_METADATA ${metadataHere()}`);
  });
  console.log('FIXTURE_READY');
});
