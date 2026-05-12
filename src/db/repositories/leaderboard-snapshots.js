'use strict';

async function findLatest(db, tourId, roundNumber, competitionType) {
  return db('leaderboard_snapshots')
    .where({ tour_id: tourId, round_number: roundNumber, competition_type: competitionType })
    .orderBy('calculated_at', 'desc')
    .first();
}

async function save(db, tourId, roundNumber, competitionType, payload) {
  const [row] = await db('leaderboard_snapshots')
    .insert({
      tour_id: tourId,
      round_number: roundNumber,
      competition_type: competitionType,
      payload: JSON.stringify(payload),
      calculated_at: db.fn.now(),
    })
    .returning('*');
  return row;
}

module.exports = { findLatest, save };
