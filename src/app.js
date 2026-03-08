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
const { isProd, nodeEnv, sessionSecret } = require('./config/env');
const { SESSION_MAX_AGE_MS } = require('./config/constants');
const { dayLabel } = require('./services/events/day-label.service');
const { calculateStablefordLeaderboards } = require('./services/scoring/stableford-leaderboard.service');

const SQLiteStore = SQLiteStoreFactory(session);
const upload = multer();

function createApp({ db, sessionStore } = {}) {
  if (!db) throw new Error('createApp requires a db instance');

  const app = express();
  const assetVersion = process.env.APP_VERSION || (nodeEnv === 'development' ? String(Date.now()) : 'prod');
  // Required behind Fly proxy so req.ip and X-Forwarded-For are handled correctly.
  app.set('trust proxy', 1);
  const championBannerCache = {
    value: null,
    loadedAt: 0,
    pending: null
  };

  async function loadChampionBanner() {
    const now = Date.now();
    if (championBannerCache.value !== null && now - championBannerCache.loadedAt < 60000) {
      return championBannerCache.value;
    }
    if (championBannerCache.pending) {
      return championBannerCache.pending;
    }
    championBannerCache.pending = (async () => {
      try {
        const championEvent = await db('events as e')
          .join('event_day_statuses as eds', function joinDay4() {
            this.on('eds.event_id', '=', 'e.id');
          })
          .where('e.is_active', 1)
          .where('eds.day', 4)
          .andWhere('eds.leaderboard_published', 1)
          .select('e.id', 'e.year')
          .first();

        if (!championEvent) {
          championBannerCache.value = null;
          championBannerCache.loadedAt = Date.now();
          return null;
        }

        const stablefordBoards = await calculateStablefordLeaderboards(db, Number(championEvent.id));
        const winner = stablefordBoards?.championship?.[0];
        if (!winner) {
          championBannerCache.value = null;
          championBannerCache.loadedAt = Date.now();
          return null;
        }

        const year = Number(championEvent.year || 0);
        const banner = {
          year,
          nextYear: year + 1,
          playerName: String(winner.name || '').trim(),
          winningTotal: Number(winner.total || 0)
        };
        championBannerCache.value = banner;
      } catch (_error) {
        // Banner is non-critical; avoid blocking requests in tests/minimal DB contexts.
        championBannerCache.value = null;
      }
      championBannerCache.loadedAt = Date.now();
      return championBannerCache.value;
    })().finally(() => {
      championBannerCache.pending = null;
    });
    return championBannerCache.pending;
  }

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

  app.use(async (req, res, next) => {
    try {
      res.locals.user = req.session?.user || null;
      res.locals.dayLabel = dayLabel;
      res.locals.assetVersion = assetVersion;
      res.locals.legendsChampionBanner = await loadChampionBanner();
      return next();
    } catch (error) {
      return next(error);
    }
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
