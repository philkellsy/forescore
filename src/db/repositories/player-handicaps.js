'use strict';

async function findByEvent(db, tourId) {
  return db('player_handicaps').where({ tour_id: tourId });
}

async function findByEventAndUser(db, tourId, userId) {
  return db('player_handicaps').where({ tour_id: tourId, user_id: userId }).first();
}

async function upsert(db, tourId, userId, playingHandicap) {
  const existing = await findByEventAndUser(db, tourId, userId);
  if (existing) {
    const [row] = await db('player_handicaps')
      .where({ id: existing.id })
      .update({ playing_handicap: playingHandicap })
      .returning('*');
    return row;
  }
  const [row] = await db('player_handicaps')
    .insert({ tour_id: tourId, user_id: userId, playing_handicap: playingHandicap })
    .returning('*');
  return row;
}

module.exports = { findByEvent, findByEventAndUser, upsert };
