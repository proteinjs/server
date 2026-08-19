/**
 * Test fixture: a REAL @proteinjs/server (the built dist — the same code prod runs) with a
 * deliberately slow endpoint, so the graceful-shutdown suite can hold a request in flight
 * while it signals the process. Run with:
 *   FIXTURE_PORT=<port> [FIXTURE_DRAIN_DELAY_MS=..] [FIXTURE_DRAIN_TIMEOUT_MS=..] node gracefulShutdownServer.js
 *
 * Markers on stdout (the suite's synchronization points):
 *   FIXTURE_READY          — startServer resolved (the listener is up)
 *   SLOW_REQUEST_STARTED   — the /slow handler is executing (a request is now in flight)
 *
 * Also serves /server-timeouts: the LIVE http.Server's keepAliveTimeout/headersTimeout (read off
 * the request's own socket), so the keep-alive suite asserts the running instance through the
 * front door instead of re-deriving values from source.
 */
const expressSession = require('express-session');
const { startServer } = require('../../dist/generated/index.js');

const port = Number(process.env.FIXTURE_PORT);
if (!port) {
  throw new Error('FIXTURE_PORT is required');
}

startServer({
  port,
  session: { secret: 'graceful-shutdown-test', store: new expressSession.MemoryStore() },
  request: {
    disableRequestLogging: true,
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
      if (request.path !== '/slow') {
        next();
        return;
      }
      console.log('SLOW_REQUEST_STARTED');
      const ms = Number(request.query.ms ?? 3000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      response.status(200).send('slow-done');
    },
  },
  shutdown: {
    drainDelayMs: process.env.FIXTURE_DRAIN_DELAY_MS ? Number(process.env.FIXTURE_DRAIN_DELAY_MS) : undefined,
    drainTimeoutMs: process.env.FIXTURE_DRAIN_TIMEOUT_MS ? Number(process.env.FIXTURE_DRAIN_TIMEOUT_MS) : undefined,
  },
}).then(() => console.log('FIXTURE_READY'));
