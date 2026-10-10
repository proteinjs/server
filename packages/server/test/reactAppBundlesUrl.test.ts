import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The page with a declared bundles URL (`ServerConfig.staticContent.bundlesUrl`): the bundles the
 * release carries under `bundlesDir` are still the page's listing, but every one is named at the
 * declared place — `<bundlesUrl>/<path under bundlesDir>` — and loaded in CORS mode
 * (`crossorigin`), on the script tag and its preload alike, so the browser reports an error thrown
 * inside a bundle in full instead of the opaque "Script error." a cross-origin classic script
 * yields. The default road (no declaration) renders exactly as before: same-origin paths, no
 * crossorigin attribute.
 *
 * Pre-fix red: the declaration is unknown to the page — every tag same-origin, nothing crossorigin.
 */
const scripts: { script: () => Promise<string> }[] = [];
jest.mock('@proteinjs/server-api', () => ({
  ...jest.requireActual('@proteinjs/server-api'),
  getServerRenderedScripts: () => scripts,
}));

import { createReactApp } from '../src/routes/reactApp';

type Rendered = { headers: Record<string, string>; html: string };

async function render(staticContent: Record<string, unknown>): Promise<Rendered> {
  const rendered: Rendered = { headers: {}, html: '' };
  const response = {
    set: (name: string, value: string) => {
      rendered.headers[name] = value;
    },
    send: (html: string) => {
      rendered.html = html;
    },
  };
  await createReactApp({ staticContent } as any).onRequest({ path: '/' }, response);
  return rendered;
}

const headOf = (html: string) => html.slice(0, html.indexOf('<body'));
const bodyOf = (html: string) => html.slice(html.indexOf('<body'));

describe('the react app page with a declared bundles URL', () => {
  let tmp: string;
  const env = {
    DEVELOPMENT: process.env.DEVELOPMENT,
    DISABLE_HOT_CLIENT_BUILDS: process.env.DISABLE_HOT_CLIENT_BUILDS,
  };

  beforeEach(() => {
    scripts.length = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'react-app-bundles-url-'));
    fs.mkdirSync(path.join(tmp, 'bundles', 'images'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'bundles', 'vendor.def456.js'), '');
    fs.writeFileSync(path.join(tmp, 'bundles', 'app.abc123.js'), '');
    fs.writeFileSync(path.join(tmp, 'bundles', 'app.abc123.js.map'), '');
    fs.writeFileSync(path.join(tmp, 'bundles', 'app.abc123.js.br'), '');
    fs.writeFileSync(path.join(tmp, 'bundles', 'images', 'mark.4d5e6f.svg'), '');
    delete process.env.DEVELOPMENT;
    delete process.env.DISABLE_HOT_CLIENT_BUILDS;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('names every bundle at the declared place, deferred and preloaded in CORS mode', async () => {
    const { html } = await render({
      staticContentDir: tmp,
      bundlesDir: 'bundles',
      bundlesUrl: 'https://assets.example.com/bundles/',
    });
    const head = headOf(html);
    const body = bodyOf(html);
    for (const bundle of [
      'https://assets.example.com/bundles/app.abc123.js',
      'https://assets.example.com/bundles/vendor.def456.js',
    ]) {
      expect(body).toContain(`<script defer src='${bundle}' crossorigin='anonymous'></script>`);
      expect(head).toContain(`<link rel='preload' href='${bundle}' as='script' crossorigin='anonymous'>`);
    }
    // Nothing same-origin is left: the release's bundles live at the declared place, all of them.
    expect(html).not.toContain("'/static/bundles/");
    expect(html).not.toContain('.js.map');
    expect(html).not.toContain('.js.br');
    expect(html).not.toContain('mark.4d5e6f.svg');
    // The order is the same stable order as the same-origin page's.
    expect(body.indexOf('app.abc123.js')).toBeLessThan(body.indexOf('vendor.def456.js'));
  });

  it('renders the same-origin page unchanged when nothing is declared — no crossorigin attribute', async () => {
    const { html } = await render({ staticContentDir: tmp, bundlesDir: 'bundles' });
    expect(bodyOf(html)).toContain("<script defer src='/static/bundles/app.abc123.js'></script>");
    expect(headOf(html)).toContain("<link rel='preload' href='/static/bundles/app.abc123.js' as='script'>");
    expect(html).not.toContain('crossorigin');
  });

  it('refuses a declaration that is not an absolute http(s) URL when the page is created, naming the field', () => {
    expect(() =>
      createReactApp({
        staticContent: { staticContentDir: tmp, bundlesDir: 'bundles', bundlesUrl: 'assets.example.com' },
      } as any)
    ).toThrow(/staticContent\.bundlesUrl/);
  });
});
