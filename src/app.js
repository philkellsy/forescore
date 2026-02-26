'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const { authRouter } = require('./routes/auth.routes');
const { indexRouter } = require('./routes/index.routes');
const { playerRouter } = require('./routes/player.routes');
const { adminRouter } = require('./routes/admin.routes');
const { scoringRouter } = require('./routes/scoring.routes');
const { leaderboardRouter } = require('./routes/leaderboard.routes');
const { isProd, sessionSecret } = require('./config/env');
const { SESSION_MAX_AGE_MS } = require('./config/constants');

const SQLiteStore = SQLiteStoreFactory(session);
const upload = multer();

function createApp({ db, sessionStore } = {}) {
  if (!db) throw new Error('createApp requires a db instance');

  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(upload.none());
  app.use(express.static(path.join(__dirname, 'public')));

  app.use(
    session({
      store: sessionStore || new SQLiteStore({ db: 'sessions.sqlite', dir: path.resolve('./data') }),
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        maxAge: SESSION_MAX_AGE_MS,
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd
      }
    })
  );

  app.use((req, res, next) => {
    res.locals.user = req.session?.user || null;
    next();
  });

  app.use('/auth', authRouter(db));
  app.use('/', indexRouter());
  app.use('/player', playerRouter(db));
  app.use('/admin', adminRouter(db));
  app.use('/scoring', scoringRouter(db));
  app.use('/leaderboards', leaderboardRouter(db));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).render('auth/error', {
      title: 'Error',
      error: isProd ? 'Unexpected server error' : err.message,
      user: null
    });
  });

  return app;
}

module.exports = { createApp };
