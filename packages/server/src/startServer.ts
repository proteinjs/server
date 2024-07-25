import express from 'express';
import expressSession from 'express-session';
import cookieParser from 'cookie-parser';
import bodyParser from 'body-parser';
import passport from 'passport';
import passportLocal from 'passport-local';
import webpack from 'webpack';
import webpackDevMiddleware from 'webpack-dev-middleware';
import webpackHotMiddleware from 'webpack-hot-middleware';
import { Server as HttpServer, IncomingMessage } from 'http';
import { Socket, Server as SocketIOServer } from 'socket.io';
import { Db } from '@proteinjs/db';
import { Global, GlobalData, ServerConfig, getGlobalDataCaches, getRoutes } from '@proteinjs/server-api';
import { loadRoutes, loadDefaultStarRoute } from './loadRoutes';
import { Logger } from '@proteinjs/util';
import { setNodeModulesPath } from './nodeModulesPath';

interface ExtendedIncomingMessage extends IncomingMessage {
  sessionID?: string;
  user?: string;
}

interface ExtendedSocket extends Socket {
  request: ExtendedIncomingMessage;
}

const staticContentPath = '/static/';
const logger = new Logger('Server');
const app = express();
const server = new HttpServer(app);
export const io = new SocketIOServer(server);

export async function startServer(config: ServerConfig) {
  const routes = getRoutes();
  await runStartupEvents(config);
  configureRequests(app);
  initializeHotReloading(app, config);
  beforeRequest(app, config);
  loadRoutes(
    routes.filter((route) => route.useHttp),
    app,
    config
  );
  configureHttps(app); // registering here forces static content to be redirected to https
  configureStaticContentRouter(app, config); // registering here prevents sessions from being created on static content requests
  configureSession(app, config);
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
  initializeSocketIO(io, app);
  start(server, config);
}

async function runStartupEvents(config: ServerConfig) {
  await new Db().init();

  if (config.onStartup) {
    await config.onStartup();
  }
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
  if (
    !process.env.DEVELOPMENT ||
    process.env.DISABLE_HOT_CLIENT_BUILDS ||
    !config.hotClientBuilds ||
    !config.staticContent?.staticContentDir ||
    !config.staticContent?.appEntryPath
  ) {
    return;
  }

  const wpConfig = Object.assign({}, getWebpackConfig(config));
  wpConfig['entry'] = { app: ['webpack-hot-middleware/client', config.staticContent.appEntryPath] };
  wpConfig['output']['path'] = config.staticContent.staticContentDir;
  wpConfig['output']['publicPath'] = staticContentPath;
  const webpackCompiler = webpack(wpConfig);
  app.use(
    webpackDevMiddleware(webpackCompiler, {
      publicPath: staticContentPath,
    })
  );
  app.use(webpackHotMiddleware(webpackCompiler));
}

function getWebpackConfig(config: ServerConfig) {
  setNodeModulesPath(config.hotClientBuilds?.nodeModulesPath as string);
  const webpackConfig = require('../webpack.config');
  return webpackConfig;
}

function configureHttps(app: express.Express) {
  app.use((request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (request.protocol == 'https' || response.headersSent || process.env.DEVELOPMENT) {
      next();
      return;
    }

    logger.debug(`Redirecting to https: ${request.headers.host + request.url}`);
    response.redirect('https://' + request.headers.host + request.url);
  });
}

function configureStaticContentRouter(app: express.Express, config: ServerConfig) {
  if (!config.staticContent?.staticContentDir) {
    return;
  }

  app.use(staticContentPath, express.static(config.staticContent.staticContentDir));
  logger.info(
    `Serving static content on path: ${staticContentPath}, serving from directory: ${config.staticContent.staticContentDir}`
  );
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
      logger.info(`Authenticating`);
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
  let requestCounter: number = 0;
  if (config.request?.disableRequestLogging == false || typeof config.request?.disableRequestLogging === 'undefined') {
    app.use((request: express.Request, response: express.Response, next: express.NextFunction) => {
      if (request.path.startsWith('/static') || request.path.startsWith('/favicon.ico')) {
        next();
        return;
      }

      const requestNumber = ++requestCounter;
      logger.info(`[#${requestNumber}] Started ${request.originalUrl}`);
      response.locals = { requestNumber };
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

  if (config.request?.disableRequestLogging == false || typeof config.request?.disableRequestLogging === 'undefined') {
    app.use((request: express.Request, response: express.Response, next: express.NextFunction) => {
      if (request.path.startsWith('/static') || request.path.startsWith('/favicon.ico')) {
        next();
        return;
      }

      logger.info(`[#${response.locals.requestNumber}] Finished ${request.originalUrl}`);
      next();
    });
  }
}

function initializeSocketIO(io: SocketIOServer, app: express.Express) {
  const logger = new Logger('SocketIOServer');

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

  // Initialize Socket.IO event handlers
  io.on('connection', (socket: ExtendedSocket) => {
    const userInfo = `${socket.request.user} (${socket.id})`;
    logger.info(`User connected: ${userInfo}`);

    // Map this socket to the session id so it can be closed when the session is destroyed
    const sessionId = socket.request.sessionID;
    if (sessionId) {
      socket.join(sessionId);
    }

    socket.on('disconnect', (reason) => {
      logger.info(`User disconnected: ${userInfo}. Reason: ${reason}`);
    });

    socket.on('error', (error) => {
      logger.error(`Socket error for user: ${userInfo}. Error:`, error);
    });

    socket.conn.on('error', (error) => {
      logger.error(`Socket connection error for user: ${userInfo}. Error:`, error);
    });
  });

  // Handle server-level errors
  io.engine.on('connection_error', (err) => {
    logger.error('Connection error:', err);
  });
}

function start(server: HttpServer, config: ServerConfig) {
  const port = config.port ? config.port : 3000;
  server.listen(port, () => {
    if (process.env.DEVELOPMENT) {
      logger.info(`Starting in development mode`);
    }

    logger.info(`Server listening on port: ${port}`);
  });
}
