'use strict';

async function findByEventDay(db, tourId, roundNumber) {
  return db('player_day_handicaps').where({ tour_id: tourId, round_number: roundNumber });
}

async function findByEventDayAndUser(db, tourId, roundNumber, userId) {
  return db('player_day_handicaps').where({ tour_id: tourId, round_number: roundNumber, user_id: userId }).first();
}

async function upsert(db, tourId, userId, roundNumber, handicapIndex) {
  const existing = await findByEventDayAndUser(db, tourId, roundNumber, userId);
  if (existing) {
    const [row] = await db('player_day_handicaps')
      .where({ id: existing.id })
      .update({ handicap_index: handicapIndex })
      .returning('*');
    return row;
  }
  const [row] = await db('player_day_handicaps')
    .insert({ tour_id: tourId, user_id: userId, round_number: roundNumber, handicap_index: handicapIndex })
    .returning('*');
  return row;
}

async function remove(db, tourId, userId, roundNumber) {
  return db('player_day_handicaps').where({ tour_id: tourId, user_id: userId, round_number: roundNumber }).delete();
}

module.exports = { findByEventDay, findByEventDayAndUser, upsert, remove };
