import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Server-rendered HEAD tags (`ServerRenderedHeadTag`): the head counterpart of the server-rendered
 * scripts. A browser reads some tags at parse time — a `<meta>` the client bundle would inject too
 * late — so the page carries them in the served document:
 *
 *  1. every registered tag lands inside `<head>`, in registration order, rendered concurrently in
 *     the page's ONE boot round (started before any resolves, like the scripts);
 *  2. the request is handed to each tag, so a tag can name the page being served;
 *  3. an empty render is dropped — nothing for this request, no blank line left behind.
 */
const scripts: { script: () => Promise<string> }[] = [];
const headTags: { headTag: (request: unknown) => Promise<string> }[] = [];
jest.mock('@proteinjs/server-api', () => ({
  ...jest.requireActual('@proteinjs/server-api'),
  getServerRenderedScripts: () => scripts,
  getServerRenderedHeadTags: () => headTags,
}));

import { createReactApp } from '../src/routes/reactApp';

type Rendered = { headers: Record<string, string>; html: string };

function renderInto(rendered: Rendered, staticContent: Record<string, unknown>, request: unknown): Promise<void> {
  const response = {
    set: (name: string, value: string) => {
      rendered.headers[name] = value;
    },
    send: (html: string) => {
      rendered.html = html;
    },
  };
  return createReactApp({ staticContent } as any).onRequest(request, response);
}

async function render(staticContent: Record<string, unknown>, request: unknown = { path: '/' }): Promise<Rendered> {
  const rendered: Rendered = { headers: {}, html: '' };
  await renderInto(rendered, staticContent, request);
  return rendered;
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

const headOf = (html: string) => html.slice(html.indexOf('<head>'), html.indexOf('</head>'));

describe('server-rendered head tags', () => {
  let tmp: string;
  const env = {
    DEVELOPMENT: process.env.DEVELOPMENT,
    DISABLE_HOT_CLIENT_BUILDS: process.env.DISABLE_HOT_CLIENT_BUILDS,
  };

  beforeEach(() => {
    scripts.length = 0;
    headTags.length = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'react-app-head-'));
    fs.mkdirSync(path.join(tmp, 'bundles'));
    fs.writeFileSync(path.join(tmp, 'bundles', 'app.js'), '');
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

  const staticContent = () => ({ staticContentDir: tmp, bundlesDir: 'bundles' });

  it('renders every tag inside <head>, in registration order, handing each the request', async () => {
    headTags.push(
      { headTag: async (request: any) => `<meta name="page" content="${request.originalUrl}">` },
      { headTag: async () => `<link rel="manifest" href="/manifest.json">` }
    );
    const { html } = await render(staticContent(), { path: '/', originalUrl: '/things?id=7' });
    const head = headOf(html);
    expect(head).toContain('<meta name="page" content="/things?id=7">');
    expect(head).toContain('<link rel="manifest" href="/manifest.json">');
    expect(head.indexOf('<meta name="page"')).toBeLessThan(head.indexOf('<link rel="manifest"'));
    // Never in the body.
    expect(html.slice(html.indexOf('<body'))).not.toContain('<meta name="page"');
  });

  it('drops an empty render — nothing for this request leaves nothing behind', async () => {
    const blankLines = (head: string) => head.split('\n').filter((line) => line.trim() === '').length;
    headTags.push({ headTag: async () => '<meta name="only" content="1">' });
    const alone = blankLines(headOf((await render(staticContent())).html));

    headTags.unshift({ headTag: async () => '' });
    const { html } = await render(staticContent());
    const head = headOf(html);
    expect(head).toContain('<meta name="only" content="1">');
    // The empty render added no line of its own: the head carries exactly the blank lines it
    // carries with the one tag alone (an unfiltered empty would join as a stray newline).
    expect(blankLines(head)).toBe(alone);
  });

  it('a page with no registered tags renders exactly as before', async () => {
    const { html } = await render(staticContent());
    expect(html).toContain('<head>');
    expect(html).not.toContain('undefined');
  });

  it('starts every tag before any resolves — the one boot round the scripts ride', async () => {
    const started: string[] = [];
    const release: Record<string, () => void> = {};
    const gated = (name: string) => ({
      headTag: () =>
        new Promise<string>((resolve) => {
          started.push(name);
          release[name] = () => resolve(`<meta name="${name}">`);
        }),
    });
    headTags.push(gated('a'), gated('b'));
    scripts.push({ script: async () => (started.push('script'), 'window.s = 1;') });

    const rendered: Rendered = { headers: {}, html: '' };
    const done = renderInto(rendered, staticContent(), { path: '/' });
    await flushMicrotasks();
    expect(started).toEqual(['script', 'a', 'b']);
    expect(rendered.html).toBe('');
    release.b();
    await flushMicrotasks();
    release.a();
    await done;
    const head = headOf(rendered.html);
    expect(head.indexOf('<meta name="a">')).toBeLessThan(head.indexOf('<meta name="b">'));
  });
});
