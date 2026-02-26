'use strict';

const { stablefordPoints } = require('./stableford.service');

async function upsertHoleScore(db, { scorecardId, holeNumber, grossScore, par, strokeIndex, playingHandicap }) {
  const stableford = stablefordPoints({ grossScore, par, strokeIndex, playingHandicap });

  const existing = await db('scorecard_holes')
    .where({ scorecard_id: scorecardId, hole_number: holeNumber })
    .first();

  if (existing) {
    await db('scorecard_holes')
      .where({ id: existing.id })
      .update({ gross_score: grossScore, stableford_points: stableford.points, updated_at: db.fn.now() });
  } else {
    await db('scorecard_holes').insert({
      scorecard_id: scorecardId,
      hole_number: holeNumber,
      gross_score: grossScore,
      stableford_points: stableford.points
    });
  }

  return stableford;
}

module.exports = { upsertHoleScore };
