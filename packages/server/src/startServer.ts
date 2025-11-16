import path from 'path';
import { createRequire } from 'module';
import express from 'express';
import expressSession from 'express-session';
import cookieParser from 'cookie-parser';
import bodyParser from 'body-parser';
import passport from 'passport';
import passportLocal from 'passport-local';
import { Server as HttpServer } from 'http';
import {
  Global,
  GlobalData,
  ServerConfig,
  StartupTask,
  getGlobalDataCaches,
  getRoutes,
  getStartupTasks,
} from '@proteinjs/server-api';
import { loadRoutes, loadDefaultStarRoute } from './loadRoutes';
import { Logger } from '@proteinjs/logger';
import { SocketIOServerRepo, ExtendedSocket } from './SocketIOServerRepo';

const staticContentPath = '/static/';
const logger = new Logger({ name: 'Server' });
const app = express();
const server = new HttpServer(app);

export async function startServer(config: ServerConfig) {
  await runStartupTasks('before server config');
  const routes = getRoutes();
  configureRequests(app);
  initializeHotReloading(app, config);
  configureSession(app, config);
  beforeRequest(app, config);
  loadRoutes(
    routes.filter((route) => route.useHttp),
    app,
    config
  );
  configureHttps(app); // registering here forces static content to be redirected to https
  configureStaticContentRouter(app, config);
  loadRoutes(
    routes.filter((route) => !route.useHttp),
    app,
    config
  );

  const globalData: GlobalData = {};
  for (const globalDataCache of getGlobalDataCaches()) {
    globalData[globalDataCache.key] = await globalDataCache.create();
  }
  Global.setData(globalData);

  loadDefaultStarRoute(routes, app, config);
  afterRequest(app, config);
  await initializeSocketIO(app, server);

  await runStartupTasks('after server config');
  if (config.onStartup) {
    logger.info({ message: `Starting ServerConfig.onStartup` });
    await config.onStartup();
    logger.info({ message: `Finished ServerConfig.onStartup` });
  }

  start(server, config);

  await runStartupTasks('after server start');
}

async function runStartupTasks(when: StartupTask['when']) {
  const filteredTasks = getStartupTasks().filter((task) => task.when === when);
  if (filteredTasks.length === 0) {
    return;
  }

  logger.info({
    message: `Starting ${filteredTasks.length} \`${when}\` startup task${filteredTasks.length > 1 ? 's' : ''}`,
  });
  await Promise.all(
    filteredTasks.map(async (task) => {
      logger.info({ message: `Starting task: ${task.name}` });
      await task.run();
      logger.info({ message: `Finished task: ${task.name}` });
    })
  );
  logger.info({
    message: `Finished ${filteredTasks.length} \`${when}\` startup task${filteredTasks.length > 1 ? 's' : ''}`,
  });
}

function configureRequests(app: express.Express) {
  app.use(cookieParser());
  app.use(bodyParser.json({ limit: '100mb' }));
  app.use(
    bodyParser.urlencoded({
      extended: true,
      limit: '100mb',
    })
  );
  app.disable('x-powered-by');
}

function initializeHotReloading(app: express.Express, config: ServerConfig) {
  // Enable only in dev with all required settings present
  if (
    !process.env.DEVELOPMENT ||
    process.env.DISABLE_HOT_CLIENT_BUILDS ||
    !config.hotClientBuilds ||
    !config.hotClientBuilds.nodeModulesPath ||
    !config.hotClientBuilds.webpackConfigPath ||
    !config.staticContent?.staticContentDir ||
    !config.staticContent?.appEntryPath
  ) {
    return;
  }

  const appRequire = makeAppRequire(config.hotClientBuilds.nodeModulesPath);

  // Load webpack & middlewares from the consumer app
  const webpack = appRequire('webpack');
  const webpackDevMiddleware = appRequire('webpack-dev-middleware');
  const webpackHotMiddleware = appRequire('webpack-hot-middleware');

  const devConfig = createWebpackConfigOverlay(config, webpack);

  const compiler = webpack(devConfig);

  app.use(
    webpackDevMiddleware(compiler, {
      publicPath: staticContentPath,
    })
  );
  app.use(webpackHotMiddleware(compiler));
}

// Resolve modules (webpack + middlewares) from the consumer’s node_modules
function makeAppRequire(nodeModulesPath: string) {
  // Any file under the consumer's node_modules works as a base for createRequire
  return createRequire(path.join(nodeModulesPath, '__app_require__.js'));
}

function createWebpackConfigOverlay(config: ServerConfig, webpack: any) {
  // Load the consumer webpack config (CommonJS). If it exports a function, call with { mode: 'development' }.
  const consumerExport = require(config.hotClientBuilds!.webpackConfigPath);
  const baseConfig = typeof consumerExport === 'function' ? consumerExport({ mode: 'development' }) : consumerExport;
  const devConfig: any = { ...baseConfig };

  devConfig.mode = 'development';

  // Inject HMR client + the consumer's entrypoint (absolute path already provided)
  // Keep it minimal: no query params; defaults are fine.
  devConfig.entry = { app: ['webpack-hot-middleware/client', config.staticContent!.appEntryPath] };

  // Ensure bundles are served from memory at /static/, and set a concrete path for plugins that read it.
  devConfig.output = {
    ...(baseConfig.output || {}),
    publicPath: staticContentPath,
    path: config.staticContent!.staticContentDir, // safe for plugins; dev-middleware serves from memory
  };

  // Ensure HMR plugin exists (idempotent)
  devConfig.plugins = devConfig.plugins ?? [];
  const hasHmr = devConfig.plugins.some((p: any) => p?.constructor?.name === 'HotModuleReplacementPlugin');
  if (!hasHmr) {
    devConfig.plugins.push(new webpack.HotModuleReplacementPlugin());
  }

  return devConfig;
}

function configureHttps(app: express.Express) {
  app.use((request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (request.protocol == 'https' || response.headersSent || process.env.DEVELOPMENT) {
      next();
      return;
    }

    logger.debug({ message: `Redirecting to https: ${request.headers.host + request.url}` });
    response.redirect('https://' + request.headers.host + request.url);
  });
}

function configureStaticContentRouter(app: express.Express, config: ServerConfig) {
  if (!config.staticContent?.staticContentDir) {
    return;
  }

  app.use(staticContentPath, express.static(config.staticContent.staticContentDir, config.staticContent.staticOptions));
  logger.info({
    message: `Serving static content on path: ${staticContentPath}, serving from directory: ${config.staticContent.staticContentDir}`,
  });
}

function configureSession(app: express.Express, config: ServerConfig) {
  const sixtyDays = 1000 * 60 * 60 * 24 * 60;
  let sessionOptions: expressSession.SessionOptions = {
    secret: config.session.secret,
    store: config.session.store,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: sixtyDays,
    },
    rolling: true,
  };

  if (!process.env.DEVELOPMENT) {
    app.set('trust proxy', 1);
    if (!sessionOptions.cookie) {
      sessionOptions.cookie = {};
    }
    sessionOptions.cookie.secure = true;
  }

  if (config.session) {
    sessionOptions = Object.assign(sessionOptions, config.session);
  }

  const sessionMiddleware = expressSession(sessionOptions);
  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());
  app.set('sessionMiddleware', sessionMiddleware); // Store the session middleware in the app for later use

  if (config.authenticate) {
    initializeAuthentication(config.authenticate);
  }
}

function initializeAuthentication(authenticate: (username: string, password: string) => Promise<true | string>) {
  passport.use(
    new passportLocal.Strategy(async function (username, password, done) {
      logger.info({ message: `Authenticating` });
      const result = await authenticate(username, password);
      if (result === true) {
        return done(null, { username });
      }

      return done(new Error(result));
    })
  );

  passport.serializeUser(function (user, done) {
    done(null, user);
  });

  passport.deserializeUser(function (id, done) {
    done(null, id);
  });
}

function beforeRequest(app: express.Express, config: ServerConfig) {
  if (config.request?.disableRequestLogging == false || typeof config.request?.disableRequestLogging === 'undefined') {
    app.use(async (request: express.Request, response: express.Response, next: express.NextFunction) => {
      if (config.authenticate) {
        await new Promise<void>((resolve, reject) => {
          passport.authenticate('local', function (err, user, info) {
            if (err) {
              reject(err);
            }

            resolve();
          })(request, response, next);
        });
      }
      next();
    });
  }

  if (config.request?.beforeRequest) {
    app.use(config.request.beforeRequest);
  }
}

function afterRequest(app: express.Express, config: ServerConfig) {
  if (config.request?.afterRequest) {
    app.use(config.request.afterRequest);
  }
}

async function initializeSocketIO(app: express.Express, server: HttpServer) {
  const io = await SocketIOServerRepo.createSocketIOServer(server);

  // Share session and passport middleware with Socket.IO
  const wrapMiddleware = (middleware: any) => (socket: any, next: any) => middleware(socket.request, {}, next);
  const sessionMiddleware = app.get('sessionMiddleware');
  io.use(wrapMiddleware(sessionMiddleware));
  io.use(wrapMiddleware(passport.initialize()));
  io.use(wrapMiddleware(passport.session()));

  // Use passport for authentication with Socket.IO
  io.use((socket: ExtendedSocket, next) => {
    if (socket.request.user) {
      next();
    } else {
      next(new Error('Unauthorized'));
    }
  });

  // Map this socket to the session id so it can be closed when the session is destroyed
  io.on('connection', (socket: ExtendedSocket) => {
    const sessionId = socket.request.sessionID;
    if (sessionId) {
      socket.join(sessionId);
    }
  });
}

function start(server: HttpServer, config: ServerConfig) {
  const port = config.port ? config.port : 3000;
  server.listen(port, () => {
    if (process.env.DEVELOPMENT) {
      logger.info({ message: `Starting in development mode` });
    }

    logger.info({ message: `Server listening on port: ${port}` });
  });
}
