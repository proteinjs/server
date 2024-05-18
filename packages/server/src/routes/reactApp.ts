import path from 'path';
import ReactHelmet from 'react-helmet';
import { ServerConfig, getServerRenderedScripts } from '@proteinjs/server-api';
import { Fs } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/util';

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
      response.send(`<!DOCTYPE html>
                <html ${helmet.htmlAttributes}>
                    <head>
                        <meta charset='utf-8' />
                        <meta name='viewport' content='width=device-width, initial-scale=1.0'>
                        <link href='${serverConfig.staticContent?.faviconPath ? path.join('/static/', serverConfig.staticContent.faviconPath) : ''}' rel='icon' type='image/x-icon' />
                        ${helmet.title.toString()}
                        ${helmet.meta.toString()}
                        ${helmet.link.toString()}
                    </head>
                    <body ${helmet.bodyAttributes.toString()}>
                        <div id='app'></div>
                        <script>proteinjs = {};</script>
                        ${await serverRenderedScriptTags()}
                        ${await bundleScriptTags(serverConfig)}
                    </body>
                </html>`);
    },
  };
};

async function bundleScriptTags(serverConfig: ServerConfig) {
  if (!(serverConfig.staticContent?.bundlePaths || serverConfig.staticContent?.bundlesDir)) {
    return;
  }

  const scriptTags: string[] = [];
  if (process.env.DEVELOPMENT && !process.env.DISABLE_HOT_CLIENT_BUILDS) {
    scriptTags.push(`<script src='${path.join('/static/', 'app.js')}'></script>`);
    scriptTags.push(`<script src='${path.join('/static/', 'vendor.js')}'></script>`);
  } else if (serverConfig.staticContent?.bundlePaths) {
    for (const bundlePath of serverConfig.staticContent.bundlePaths) {
      scriptTags.push(`<script src='${path.join('/static/', bundlePath)}'></script>`);
    }
  } else if (serverConfig.staticContent?.bundlesDir && serverConfig.staticContent?.staticContentDir) {
    const resolvedBundlesDir = path.join(
      serverConfig.staticContent.staticContentDir,
      serverConfig.staticContent.bundlesDir
    );
    const filePaths = await Fs.getFilePathsMatchingGlob(resolvedBundlesDir, '**/*.js');
    for (const filePath of filePaths) {
      const relativePath = path.relative(serverConfig.staticContent.staticContentDir, filePath);
      scriptTags.push(`<script src='${path.join('/static/', relativePath)}'></script>`);
    }
  }

  return scriptTags.join('\n');
}

async function serverRenderedScriptTags() {
  const logger = new Logger('Server');
  const scripts = getServerRenderedScripts();
  const scriptTags: string[] = [];
  for (const script of scripts) {
    scriptTags.push(`<script>${await script.script()}</script>`);
    logger.info(`Scripts: ${script}`);
  }

  return scriptTags.join('\n');
}
