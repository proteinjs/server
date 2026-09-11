import path from 'path';
import ReactHelmet from 'react-helmet';
import { ServerConfig, getServerRenderedScripts } from '@proteinjs/server-api';
import { Fs } from '@proteinjs/util-node';
import { DevClientBuild } from '../DevClientBuild';

// Browser-chrome ground colors mirrored from @n3xah/util-ui Theme.tsx getTheme()
// (lightPalette/darkPalette `background.default`) — proteinjs cannot import n3xah,
// so the hex values are hard-coded here and must track that file.
const THEME_COLOR_LIGHT = '#FFFFFF';
const THEME_COLOR_DARK = '#202020';

export const createReactApp = (serverConfig: ServerConfig) => {
  return {
    path: '*',
    method: 'get' as 'get',
    onRequest: async (request: any, response: any): Promise<void> => {
      if (request.path.startsWith('/static')) {
        return;
      }

      if (!(serverConfig.staticContent?.bundlePaths || serverConfig.staticContent?.bundlesDir)) {
        throw new Error(`ServerConfig.bundlePath or ServerConfig.bundlesDir must be provided to serve a react app`);
      }

      const helmet = ReactHelmet.renderStatic();
      // ONE boot round: the server-rendered scripts (each a settings read for the logged-in user)
      // and the bundle listing run concurrently — the page's TTFB is the SLOWEST of them, not their
      // sum (measured on a phone: 5–6 reads awaited one after another sat in front of every byte
      // of the page).
      const [serverRenderedScripts, bundleUrls] = await Promise.all([
        serverRenderedScriptTags(),
        bundleScriptUrls(serverConfig),
      ]);
      // The page must ALWAYS revalidate (found live 2026-09-01, the mobile-app stale-page
      // investigation): without an explicit policy, HTTP heuristic caching applies (RFC 9111
      // §4.2.2) — WKWebView in particular can serve the cached page without revalidating,
      // across app force-quits, pinning stale bundle POINTERS long after a deploy. The hashed
      // bundles under /static keep their long cache (a fresh page always points at fresh
      // hashes); `no-cache` + the ETag express already stamps = a cheap 304 on every load.
      response.set('Cache-Control', 'no-cache');
      response.send(`<!DOCTYPE html>
                <html ${helmet.htmlAttributes}>
                    <head>
                        <meta charset='utf-8' />
                        <meta name='viewport' content='width=device-width, initial-scale=1.0, maximum-scale=1, viewport-fit=cover'>
                        <meta name='theme-color' content='${THEME_COLOR_LIGHT}' media='(prefers-color-scheme: light)'>
                        <meta name='theme-color' content='${THEME_COLOR_DARK}' media='(prefers-color-scheme: dark)'>
                        <link href='${serverConfig.staticContent?.faviconPath ? path.join('/static/', serverConfig.staticContent.faviconPath) : ''}' rel='icon' type='image/png' />
                        ${bundlePreloadTags(bundleUrls)}
                        ${helmet.title.toString()}
                        ${helmet.meta.toString()}
                        ${helmet.link.toString()}
                    </head>
                    <body ${helmet.bodyAttributes.toString()}>
                        <div id='app'></div>
                        <script>proteinjs = {};</script>
                        ${serverRenderedScripts}
                        ${bundleScriptTags(bundleUrls)}
                    </body>
                </html>`);
    },
  };
};

/**
 * The bundle URLs the page loads, in load order. Dev: the entrypoint's files as the LAST compile
 * recorded them (DevClientBuild — the page follows the chunk graph the webpack config declares),
 * each stamped `?v=<hash>` so the page is verifiable against /dev/build-info (matching hash =
 * provably running the current build). Prod: the configured bundle paths, or every `.js` under the
 * bundles dir in a stable (sorted) order — webpack's runtime registers chunks in any order.
 */
async function bundleScriptUrls(serverConfig: ServerConfig): Promise<string[]> {
  if (!(serverConfig.staticContent?.bundlePaths || serverConfig.staticContent?.bundlesDir)) {
    return [];
  }

  if (process.env.DEVELOPMENT && !process.env.DISABLE_HOT_CLIENT_BUILDS) {
    const build = DevClientBuild.get();
    if (!build) {
      // start() gates the listen READY on the first compile, so a page is never served before
      // a build is recorded; a missing record is a wiring fault, said aloud rather than papered.
      throw new Error('the dev client build has not been recorded yet — no bundle to serve');
    }
    return build.assets.map((asset) => `${path.join('/static/', asset)}?v=${build.hash}`);
  }

  if (serverConfig.staticContent?.bundlePaths) {
    return serverConfig.staticContent.bundlePaths.map((bundlePath) => path.join('/static/', bundlePath));
  }

  if (serverConfig.staticContent?.bundlesDir && serverConfig.staticContent?.staticContentDir) {
    const staticContentDir = serverConfig.staticContent.staticContentDir;
    const resolvedBundlesDir = path.join(staticContentDir, serverConfig.staticContent.bundlesDir);
    const filePaths = await Fs.getFilePathsMatchingGlob(resolvedBundlesDir, '**/*.js');
    return filePaths
      .map((filePath) => path.join('/static/', path.relative(staticContentDir, filePath)))
      .sort();
  }

  return [];
}

/**
 * `defer`: the bundles download in parallel WHILE the HTML parses and execute in document order
 * once it has — a synchronous `<script src>` blocked the parser on every byte of the vendor chunk,
 * and on iOS the previous page stayed painted (and tappable) under the user's thumb until the new
 * document's first paint. The inline server-rendered scripts above them still run at parse time,
 * so `proteinjs[...]` globals exist before any bundle executes.
 */
function bundleScriptTags(bundleUrls: string[]): string {
  return bundleUrls.map((url) => `<script defer src='${url}'></script>`).join('\n');
}

/** `<link rel=preload>` in the head: the fetches start from the first bytes of the document. */
function bundlePreloadTags(bundleUrls: string[]): string {
  return bundleUrls.map((url) => `<link rel='preload' href='${url}' as='script'>`).join('\n');
}

/** Every server-rendered script rendered CONCURRENTLY; emitted in registration order. */
async function serverRenderedScriptTags(): Promise<string> {
  const scripts = getServerRenderedScripts();
  const rendered = await Promise.all(scripts.map((script) => script.script()));
  return rendered.map((script) => `<script>${script}</script>`).join('\n');
}
