/**
 * Test fixture: a REAL @proteinjs/server (the built dist — run `npm run build` first) whose
 * `before server config` startup task REJECTS — the shape of a schema sync the database refused
 * (two loaded copies of one table's declaration: "Duplicate name in schema") — started the way a
 * consumer starts it: a bare `startServer(config)` call, nothing awaiting or catching it. Run with:
 *   FIXTURE_PORT=<port> node [--unhandled-rejections=warn|throw] bootFailureServer.js
 *
 * Markers on stdout: FIXTURE_LISTENING — the listener opened (must never print: the boot fails
 * ahead of it).
 */
const { registerSourceObject } = require('./registerSourceObject');
const { startServer } = require('../../dist/generated/index.js');

const port = Number(process.env.FIXTURE_PORT);
if (!port) {
  throw new Error('FIXTURE_PORT is required');
}

registerSourceObject('@proteinjs/server-api/StartupTask', 'failingSchemaSync', {
  name: 'Synchronize the schema',
  when: 'before server config',
  run: async () => {
    throw Object.assign(new Error('9 FAILED_PRECONDITION: Duplicate name in schema: example_table'), { code: 9 });
  },
});

// What a database client's open channel does to the event loop: the process never ends on its own, so a boot
// whose rejection is only WARNED about idles — no listener, no exit — until something ends it.
setInterval(() => undefined, 60_000);

// A consumer's shape: the boot is started, never awaited. The framework owns what a failed boot does.
startServer({
  port,
  session: { secret: 'boot-failure-test' },
  staticContent: { bundlePaths: ['bundles/app.test.js'] },
  onStartup: async () => console.log('FIXTURE_LISTENING'),
});
