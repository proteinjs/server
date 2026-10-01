/**
 * The dev page injects only the entrypoints' scripts — never a hot-update chunk.
 *
 * On every incremental compile webpack's HotModuleReplacementPlugin emits
 * `<entry>.<previous hash>.hot-update.js` AND adds it to the entry chunk's files, so the stats'
 * entrypoint listing (what DevClientBuild records) carries it beside `vendor.js` and `app.js`. That
 * chunk is an HMR payload for a page already running the previous compile: it calls
 * `webpackHotUpdate…` on a runtime that must already exist. Served as a `<script>` of a FRESH page
 * load it throws (`Cannot set properties of undefined`) and the page is broken until the next
 * server start, whose first compile is full and carries no hot-update chunk.
 *
 * Pre-fix red: the record kept every `.js` on the entrypoint, the hot-update chunk included, and
 * the page rendered a `<script defer src='/static/app.<hash>.hot-update.js?v=…'>` for it.
 *
 * The fixtures are real stats (`stats.toJson(DevClientBuild.STATS_OPTIONS)`) from a webpack 5.88
 * watch under the dev server's overlay shape (HotModuleReplacementPlugin, the hot client as the
 * first entry module, entry `app`, a `vendor` cache group over node_modules, separate source maps):
 * `initial` is the first, full compile; `incremental` the compile after one source edit.
 */
const scripts: { script: () => Promise<string> }[] = [];
jest.mock('@proteinjs/server-api', () => ({
  ...jest.requireActual('@proteinjs/server-api'),
  getServerRenderedScripts: () => scripts,
}));

import { createReactApp } from '../src/routes/reactApp';
import { DevClientBuild, DevClientBuildStats } from '../src/DevClientBuild';
import initialStats from './fixture/dev-build-stats.initial.json';
import incrementalStats from './fixture/dev-build-stats.incremental.json';

async function renderDevPage(): Promise<string> {
  let html = '';
  const response = { set: () => undefined, send: (page: string) => (html = page) };
  await createReactApp({ staticContent: { bundlesDir: 'bundles', staticContentDir: '/nowhere' } } as any).onRequest(
    { path: '/' },
    response
  );
  return html;
}

/** Every bundle `<script>` of the page, in document order. */
function bundleScripts(html: string): string[] {
  const tag = /<script defer src='([^']+)'><\/script>/g;
  const urls: string[] = [];
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    urls.push(match[1]);
  }
  return urls;
}

describe('the dev page injects only the entrypoint scripts', () => {
  const development = process.env.DEVELOPMENT;

  beforeEach(() => {
    process.env.DEVELOPMENT = 'true';
  });

  afterEach(() => {
    if (development === undefined) {
      delete process.env.DEVELOPMENT;
    } else {
      process.env.DEVELOPMENT = development;
    }
  });

  it('an incremental compile: the entry chunks, never the hot-update chunk webpack added to the entry', async () => {
    const stats = incrementalStats as DevClientBuildStats;
    // The premise, from the fixture itself: webpack listed the hot-update chunk on the entrypoint.
    expect(stats.entrypoints!.app.assets!.map((asset) => (typeof asset === 'string' ? asset : asset.name))).toEqual([
      'vendor.js',
      'app.js',
      'app.d6f2b54ca7861d44af32.hot-update.js',
    ]);

    DevClientBuild.record(DevClientBuild.fromStats(stats));
    const html = await renderDevPage();

    expect(bundleScripts(html)).toEqual([`/static/vendor.js?v=${stats.hash}`, `/static/app.js?v=${stats.hash}`]);
    expect(html).not.toContain('hot-update');
    expect(DevClientBuild.get()!.assets).toEqual(['vendor.js', 'app.js']);
  });

  it('a full compile: the entry chunks, nothing else', async () => {
    const stats = initialStats as DevClientBuildStats;
    DevClientBuild.record(DevClientBuild.fromStats(stats));
    const html = await renderDevPage();

    expect(bundleScripts(html)).toEqual([`/static/vendor.js?v=${stats.hash}`, `/static/app.js?v=${stats.hash}`]);
    expect(html).not.toContain('.js.map');
    expect(DevClientBuild.get()).toMatchObject({ hash: stats.hash, errorCount: 0, assets: ['vendor.js', 'app.js'] });
  });
});
