'use strict';

async function findByTour(db, tourId) {
  return db('golf_rounds').where({ tour_id: tourId }).orderBy('round_number');
}

async function findByRound(db, tourId, roundNumber) {
  return db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
}

async function upsert(db, data) {
  const { tour_id, round_number, ...rest } = data;
  const existing = await findByRound(db, tour_id, round_number);
  if (existing) {
    const [row] = await db('golf_rounds')
      .where({ id: existing.id })
      .update(rest)
      .returning('*');
    return row;
  }
  const [row] = await db('golf_rounds').insert(data).returning('*');
  return row;
}

async function updateStatus(db, tourId, roundNumber, status) {
  const [row] = await db('golf_rounds')
    .where({ tour_id: tourId, round_number: roundNumber })
    .update({ status })
    .returning('*');
  return row;
}

async function setPublished(db, tourId, roundNumber, published) {
  const [row] = await db('golf_rounds')
    .where({ tour_id: tourId, round_number: roundNumber })
    .update({ leaderboard_published: published })
    .returning('*');
  return row;
}

module.exports = { findByTour, findByRound, upsert, updateStatus, setPublished };
