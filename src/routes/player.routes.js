'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ROLES } = require('../config/roles');

function playerRouter(db) {
  const router = express.Router();

  router.get('/dashboard', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== ROLES.PLAYER && user.role !== ROLES.SCORER && user.role !== ROLES.ADMIN) {
      return res.status(403).render('auth/forbidden', { title: 'Forbidden', user });
    }

    const recentScores = await db('scorecards as s')
      .leftJoin('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
      .where('s.user_id', user.id)
      .groupBy('s.id', 's.day', 's.status')
      .select('s.id', 's.day', 's.status')
      .sum({ totalGross: 'sh.gross_score' })
      .sum({ totalStableford: 'sh.stableford_points' })
      .orderBy('s.day', 'asc');

    return res.render('player/dashboard', {
      title: 'Player Dashboard',
      user,
      recentScores
    });
  });

  return router;
}

module.exports = { playerRouter };
