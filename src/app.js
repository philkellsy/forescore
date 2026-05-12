'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const { authRouter } = require('./routes/auth.routes');
const { adminRouter } = require('./routes/admin.routes');
const { superAdminRouter } = require('./routes/super-admin.routes');
const { scoringRouter } = require('./routes/scoring.routes');
const { leaderboardRouter } = require('./routes/leaderboard.routes');
const { playerRouter } = require('./routes/player.routes');
const { isProd, nodeEnv, sessionSecret, databaseUrl } = require('./config/env');
const { SESSION_MAX_AGE_MS } = require('./config/constants');
const { tenantMiddleware } = require('./middleware/tenant');
const { requireAuth } = require('./middleware/auth');

const upload = multer();

function createApp({ db, sessionStore } = {}) {
  if (!db) throw new Error('createApp requires a db instance');

  const app = express();
  const { version } = require('../package.json');
  const assetVersion = process.env.APP_VERSION || (nodeEnv === 'development' ? String(Date.now()) : version);

  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(upload.none());
  app.use(express.static(path.join(__dirname, 'public')));

  const isRemoteDb = databaseUrl && !databaseUrl.includes('localhost') && !databaseUrl.includes('127.0.0.1') && !databaseUrl.includes('.railway.internal');
  const store = sessionStore || new PgSession({
    conObject: {
      connectionString: databaseUrl,
      ssl: isRemoteDb ? { rejectUnauthorized: false } : false,
    },
    tableName: 'sessions',
    createTableIfMissing: true,
  });

  app.use(session({
    store,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: SESSION_MAX_AGE_MS,
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
    },
  }));

  // Global locals — tenantPath is overridden per-request by tenantMiddleware
  app.use((req, res, next) => {
    res.locals.user = req.session?.user || null;
    res.locals.assetVersion = assetVersion;
    res.locals.tenantPath = (p) => p;
    res.locals.isSuperAdmin = Boolean(req.session?.user?.isSuperAdmin);
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Global routes: root picker + tenant create (no tenant slug)
  app.use('/', superAdminRouter(db));

  // All application routes live under /:tenantSlug
  const tenantRouter = express.Router({ mergeParams: true });
  tenantRouter.use(tenantMiddleware(db));
  tenantRouter.use('/auth', authRouter(db));
  tenantRouter.use('/admin', adminRouter(db));
  tenantRouter.use('/scoring', scoringRouter(db));
  tenantRouter.use('/leaderboards', leaderboardRouter(db));
  tenantRouter.use('/', playerRouter(db));

  app.use('/:tenantSlug', tenantRouter);

  app.use((_req, res) => res.status(404).send('Not found'));

  app.use((err, _req, res, _next) => {
    console.error(err);
    if (res.headersSent) return;
    try {
      res.status(500).render('auth/error', {
        title: 'Error',
        error: isProd ? 'Unexpected server error' : err.message,
        user: null,
      });
    } catch {
      res.status(500).send(isProd ? 'Server error' : err.message);
    }
  });

  return app;
}

module.exports = { createApp };
