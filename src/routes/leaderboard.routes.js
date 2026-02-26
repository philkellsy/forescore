'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { buildLeaderboards } = require('../services/leaderboard/leaderboard.service');

function leaderboardRouter(db) {
  const router = express.Router();

  router.get('/', requireAuth, async (req, res, next) => {
    try {
      const active = await db('events').where({ is_active: 1 }).first();
      if (!active) {
        return res.render('leaderboard/index', {
          title: 'Leaderboards',
          user: req.session.user,
          activeEvent: null,
          boards: { ambrose: [], eclectic: [], sultans: [] }
        });
      }

      const boards = await buildLeaderboards(db, active.id);
      return res.render('leaderboard/index', {
        title: 'Leaderboards',
        user: req.session.user,
        activeEvent: active,
        boards
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { leaderboardRouter };
