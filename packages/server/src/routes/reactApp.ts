import path from 'path';
import ReactHelmet from 'react-helmet';
import { ServerConfig, getServerRenderedScripts } from '@proteinjs/server-api';

export const createReactApp = (serverConfig: ServerConfig) => {
    return {
        path: '*',
        method: 'get' as 'get',
        onRequest: async (request: any, response: any): Promise<void> => {
            if (request.path.startsWith('/static'))
                return;

            if (!serverConfig.staticContent?.bundlePaths)
                throw new Error(`ServerConfig.bundlePath must be provided to serve react app`);

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
                        ${bundleScriptTags(serverConfig)}
                    </body>
                </html>`
            );
        }
    }
}

function bundleScriptTags(serverConfig: ServerConfig) {
    if (!serverConfig.staticContent?.bundlePaths)
        return;

    const scriptTags: string[] = [];
    for (const bundlePath of serverConfig.staticContent.bundlePaths)
        scriptTags.push(`<script src='${path.join('/static/', bundlePath)}'></script>`);

    return scriptTags.join('\n');
}

async function serverRenderedScriptTags() {
    const scripts = getServerRenderedScripts();
    const scriptTags: string[] = [];
    for (const script of scripts)
        scriptTags.push(`<script>${await script.script()}</script>`);

    return scriptTags.join('\n');
}