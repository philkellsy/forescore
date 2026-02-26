'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { canEditAllScores } = require('../services/permissions/scoring-permissions.service');
const { upsertHoleScore } = require('../services/scoring/score-entry.service');

function scoringRouter(db) {
  const router = express.Router();

  router.get('/', requireAuth, async (req, res) => {
    const user = req.session.user;

    const scorecards = await db('scorecards as s')
      .leftJoin('users as u', 'u.id', 's.user_id')
      .select('s.id', 's.day', 's.type', 's.status', 'u.first_name', 'u.last_name')
      .modify((q) => {
        if (!canEditAllScores(user)) q.where('s.user_id', user.id);
      })
      .orderBy([{ column: 's.day', order: 'asc' }, { column: 's.id', order: 'asc' }]);

    return res.render('scorer/index', {
      title: 'Scoring',
      user,
      scorecards,
      canEditAll: canEditAllScores(user)
    });
  });

  router.post('/:scorecardId/hole', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const holeNumber = Number(req.body.holeNumber);
      const grossScore = Number(req.body.grossScore);

      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).send('Scorecard not found');

      const user = req.session.user;
      if (!canEditAllScores(user) && scorecard.user_id !== user.id) {
        return res.status(403).send('Not allowed');
      }

      const handicap = await db('player_handicaps')
        .where({ event_id: scorecard.event_id, user_id: scorecard.user_id })
        .first();

      const hole = await db('holes as h')
        .join('courses as c', 'c.id', 'h.course_id')
        .where({ 'c.event_id': scorecard.event_id, 'h.hole_number': holeNumber })
        .select('h.par', 'h.stroke_index')
        .first();

      if (!hole) return res.status(400).send('Hole configuration missing');

      await upsertHoleScore(db, {
        scorecardId,
        holeNumber,
        grossScore,
        par: hole.par,
        strokeIndex: hole.stroke_index,
        playingHandicap: handicap?.playing_handicap || 0
      });

      return res.redirect('/scoring');
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { scoringRouter };
