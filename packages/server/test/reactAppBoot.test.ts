import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The react app page's boot shape:
 *
 *  1. ONE boot round — every server-rendered script (each a settings read for the logged-in user)
 *     is rendered CONCURRENTLY, and emitted in registration order regardless of which resolves
 *     first. Pre-fix red: reactApp.ts awaited the scripts one after another (the page's TTFB was
 *     the SUM of 5–6 serial reads), so the second script did not START until the first resolved.
 *  2. The bundles are `defer`red and `<link rel=preload>`ed from the head — a synchronous body
 *     `<script src>` blocked the parser on every byte of the vendor chunk. Pre-fix red: no defer,
 *     no preload.
 *  3. The dev page renders its bundle tags from the compile's own entrypoint files (DevClientBuild
 *     `assets`), each stamped `?v=<hash>` — the page follows the chunk graph the webpack config
 *     declares, and stays verifiable against /dev/build-info. Pre-fix red: two hard-coded names.
 */
const scripts: { script: () => Promise<string> }[] = [];
jest.mock('@proteinjs/server-api', () => ({
  ...jest.requireActual('@proteinjs/server-api'),
  getServerRenderedScripts: () => scripts,
}));

import { createReactApp } from '../src/routes/reactApp';
import { DevClientBuild } from '../src/DevClientBuild';

type Rendered = { headers: Record<string, string>; html: string };

async function render(staticContent: Record<string, unknown>): Promise<Rendered> {
  const rendered: Rendered = { headers: {}, html: '' };
  await renderInto(rendered, staticContent);
  return rendered;
}

function renderInto(rendered: Rendered, staticContent: Record<string, unknown>): Promise<void> {
  const response = {
    set: (name: string, value: string) => {
      rendered.headers[name] = value;
    },
    send: (html: string) => {
      rendered.html = html;
    },
  };
  return createReactApp({ staticContent } as any).onRequest({ path: '/' }, response);
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

describe('the react app page boots in one round', () => {
  let tmp: string;
  const env = { DEVELOPMENT: process.env.DEVELOPMENT, DISABLE_HOT_CLIENT_BUILDS: process.env.DISABLE_HOT_CLIENT_BUILDS };

  beforeEach(() => {
    scripts.length = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'react-app-boot-'));
    fs.mkdirSync(path.join(tmp, 'bundles'));
    delete process.env.DEVELOPMENT;
    delete process.env.DISABLE_HOT_CLIENT_BUILDS;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (env.DEVELOPMENT === undefined) {
      delete process.env.DEVELOPMENT;
    } else {
      process.env.DEVELOPMENT = env.DEVELOPMENT;
    }
    if (env.DISABLE_HOT_CLIENT_BUILDS === undefined) {
      delete process.env.DISABLE_HOT_CLIENT_BUILDS;
    } else {
      process.env.DISABLE_HOT_CLIENT_BUILDS = env.DISABLE_HOT_CLIENT_BUILDS;
    }
  });

  const prodStaticContent = () => ({ staticContentDir: tmp, bundlesDir: 'bundles' });

  it('pin 1: every server-rendered script STARTS before any resolves, and they are emitted in registration order', async () => {
    fs.writeFileSync(path.join(tmp, 'bundles', 'app.js'), '');
    const started: string[] = [];
    const release: Record<string, () => void> = {};
    const gated = (name: string) => ({
      script: () =>
        new Promise<string>((resolve) => {
          started.push(name);
          release[name] = () => resolve(`window.${name} = 1;`);
        }),
    });
    scripts.push(gated('a'), gated('b'), { script: async () => (started.push('c'), 'window.c = 1;') });

    const rendered: Rendered = { headers: {}, html: '' };
    const done = renderInto(rendered, prodStaticContent());
    await flushMicrotasks();
    // Pre-fix red: ['a'] — the page awaited a's read before b's began.
    expect(started).toEqual(['a', 'b', 'c']);
    expect(rendered.html).toBe('');

    // b answers first; the page still carries a, b, c in registration order.
    release.b();
    await flushMicrotasks();
    release.a();
    await done;
    const order = ['window.a = 1;', 'window.b = 1;', 'window.c = 1;'].map((s) => rendered.html.indexOf(`<script>${s}</script>`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    // The globals object the scripts write into is declared ahead of them.
    expect(rendered.html.indexOf('<script>proteinjs = {};</script>')).toBeLessThan(order[0]);
  });

  it('pin 2: the production bundles are deferred and preloaded from the head, in a stable order', async () => {
    fs.writeFileSync(path.join(tmp, 'bundles', 'vendor.def456.js'), '');
    fs.writeFileSync(path.join(tmp, 'bundles', 'app.abc123.js'), '');
    fs.writeFileSync(path.join(tmp, 'bundles', 'app.abc123.js.map'), '');
    fs.writeFileSync(path.join(tmp, 'bundles', 'app.abc123.js.br'), '');
    scripts.push({ script: async () => 'window.settings = {};' });

    const { html, headers } = await render(prodStaticContent());
    const head = html.slice(0, html.indexOf('<body'));
    const body = html.slice(html.indexOf('<body'));
    for (const bundle of ['/static/bundles/app.abc123.js', '/static/bundles/vendor.def456.js']) {
      // Pre-fix red: `<script src=…>` with no defer; no preload anywhere.
      expect(body).toContain(`<script defer src='${bundle}'></script>`);
      expect(head).toContain(`<link rel='preload' href='${bundle}' as='script'>`);
    }
    expect(body).not.toMatch(/<script src=/);
    expect(html).not.toContain('.js.map');
    expect(html).not.toContain('.js.br');
    // Stable order: sorted paths, app before vendor.
    expect(body.indexOf('app.abc123.js')).toBeLessThan(body.indexOf('vendor.def456.js'));
    // The inline scripts run at parse time, ahead of the deferred bundles.
    expect(body.indexOf('<script>window.settings = {};</script>')).toBeLessThan(body.indexOf('<script defer'));
    expect(headers['Cache-Control']).toBe('no-cache');
  });

  it('pin 3: the dev page renders the compile’s own entrypoint files, each stamped ?v=<hash>, deferred and preloaded', async () => {
    process.env.DEVELOPMENT = 'true';
    DevClientBuild.record({
      hash: 'cafe0123',
      builtAt: new Date().toISOString(),
      errorCount: 0,
      assets: ['react.js', 'vendor.js', 'app.js'],
    });
    scripts.push({ script: async () => 'window.settings = {};' });

    const { html } = await render(prodStaticContent());
    const body = html.slice(html.indexOf('<body'));
    const head = html.slice(0, html.indexOf('<body'));
    const tags = ['react.js', 'vendor.js', 'app.js'].map((asset) => body.indexOf(`<script defer src='/static/${asset}?v=cafe0123'></script>`));
    // Pre-fix red: two hard-coded names (app.js, vendor.js), no react.js, no defer.
    expect(tags.every((i) => i >= 0)).toBe(true);
    expect(tags).toEqual([...tags].sort((x, y) => x - y));
    for (const asset of ['react.js', 'vendor.js', 'app.js']) {
      expect(head).toContain(`<link rel='preload' href='/static/${asset}?v=cafe0123' as='script'>`);
    }
    expect(body).not.toContain('bundles/');
  });
});
