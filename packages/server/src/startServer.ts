import express from 'express';
import expressSession from 'express-session';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import bodyParser from 'body-parser';
import passport from 'passport';
import passportLocal from 'passport-local';
import webpack from 'webpack';
import webpackDevMiddleware from 'webpack-dev-middleware';
import webpackHotMiddleware from 'webpack-hot-middleware';
import { Db } from '@proteinjs/db';
import { ServerConfig, getRoutes } from '@proteinjs/server-api';
import { loadRoutes, loadDefaultStarRoute } from './loadRoutes';
import { Logger } from '@proteinjs/util';
import { setNodeModulesPath } from './nodeModulesPath';

const staticContentPath = '/static/';
const logger = new Logger('Server');

export async function startServer(config: ServerConfig) {
  const routes = getRoutes();
  await runStartupEvents(config);
  const server = express();
  configureRequests(server);
  initializeHotReloading(server, config);
  beforeRequest(server, config);
  loadRoutes(
    routes.filter((route) => route.useHttp),
    server,
    config
  );
  configureHttps(server); // registering here forces static content to be redirected to https
  configureStaticContentRouter(server, config); // registering here prevents sessions from being created on static content requests
  configureSession(server, config);
  loadRoutes(
    routes.filter((route) => !route.useHttp),
    server,
    config
  );
  loadDefaultStarRoute(routes, server, config);
  afterRequest(server, config);
  start(server, config);
}

async function runStartupEvents(config: ServerConfig) {
  await new Db().init();

  if (config.onStartup) await config.onStartup();
}

function configureRequests(server: express.Express) {
  server.use(compression());
  server.use(cookieParser());
  server.use(bodyParser.json({ limit: '100mb' }));
  server.use(
    bodyParser.urlencoded({
      extended: true,
      limit: '100mb',
    })
  );
  server.disable('x-powered-by');
}

function initializeHotReloading(server: express.Express, config: ServerConfig) {
  if (
    !process.env.DEVELOPMENT ||
    process.env.DISABLE_HOT_CLIENT_BUILDS ||
    !config.hotClientBuilds ||
    !config.staticContent?.staticContentDir ||
    !config.staticContent?.appEntryPath
  )
    return;

  const wpConfig = Object.assign({}, getWebpackConfig(config));
  wpConfig['entry'] = { app: ['webpack-hot-middleware/client', config.staticContent.appEntryPath] };
  wpConfig['output']['path'] = config.staticContent.staticContentDir;
  wpConfig['output']['publicPath'] = staticContentPath;
  const webpackCompiler = webpack(wpConfig);
  server.use(
    webpackDevMiddleware(webpackCompiler, {
      publicPath: staticContentPath,
    })
  );
  server.use(webpackHotMiddleware(webpackCompiler));
}

function getWebpackConfig(config: ServerConfig) {
  setNodeModulesPath(config.hotClientBuilds?.nodeModulesPath as string);
  const webpackConfig = require('../webpack.config');
  return webpackConfig;
}

function configureHttps(server: express.Express) {
  server.use((request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (request.protocol == 'https' || response.headersSent || process.env.DEVELOPMENT) {
      next();
      return;
    }

    logger.debug(`Redirecting to https: ${request.headers.host + request.url}`);
    response.redirect('https://' + request.headers.host + request.url);
  });
}

function configureStaticContentRouter(server: express.Express, config: ServerConfig) {
  if (!config.staticContent?.staticContentDir) return;

  server.use(staticContentPath, express.static(config.staticContent.staticContentDir));
  logger.info(
    `Serving static content on path: ${staticContentPath}, serving from directory: ${config.staticContent.staticContentDir}`
  );
}

function configureSession(server: express.Express, config: ServerConfig) {
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
    server.set('trust proxy', 1);
    if (!sessionOptions.cookie) sessionOptions.cookie = {};
    sessionOptions.cookie.secure = true;
  }

  if (config.session) sessionOptions = Object.assign(sessionOptions, config.session);

  server.use(expressSession(sessionOptions));
  server.use(passport.initialize());
  server.use(passport.session());
  if (config.authenticate) initializeAuthentication(config.authenticate);
}

function initializeAuthentication(authenticate: (username: string, password: string) => Promise<true | string>) {
  passport.use(
    new passportLocal.Strategy(async function (username, password, done) {
      logger.info(`Authenticating`);
      const result = await authenticate(username, password);
      if (result === true) return done(null, { username });

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

function beforeRequest(server: express.Express, config: ServerConfig) {
  let requestCounter: number = 0;
  if (config.request?.disableRequestLogging == false || typeof config.request?.disableRequestLogging === 'undefined') {
    server.use((request: express.Request, response: express.Response, next: express.NextFunction) => {
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

  if (config.request?.beforeRequest) server.use(config.request.beforeRequest);
}

function afterRequest(server: express.Express, config: ServerConfig) {
  if (config.request?.afterRequest) server.use(config.request.afterRequest);

  if (config.request?.disableRequestLogging == false || typeof config.request?.disableRequestLogging === 'undefined') {
    server.use((request: express.Request, response: express.Response, next: express.NextFunction) => {
      if (request.path.startsWith('/static') || request.path.startsWith('/favicon.ico')) {
        next();
        return;
      }

      logger.info(`[#${response.locals.requestNumber}] Finished ${request.originalUrl}`);
      next();
    });
  }
}

function start(server: express.Express, config: ServerConfig) {
  const port = config.port ? config.port : 3000;
  server.listen(port, () => {
    if (process.env.DEVELOPMENT) logger.info(`Starting in development mode`);

    logger.info(`Server listening on port: ${port}`);
  });
}
