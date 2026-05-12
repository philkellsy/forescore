'use strict';

async function findByEventDay(db, tourId, roundNumber) {
  return db('novelty_events').where({ tour_id: tourId, round_number: roundNumber }).orderBy('hole_number');
}

async function create(db, data) {
  const [row] = await db('novelty_events').insert(data).returning('*');
  return row;
}

async function findResult(db, noveltyEventId) {
  return db('novelty_results').where({ novelty_event_id: noveltyEventId }).first();
}

// Inserts or updates a novelty result for a given novelty_event
async function setResult(db, noveltyEventId, data) {
  const existing = await findResult(db, noveltyEventId);
  if (existing) {
    const [row] = await db('novelty_results')
      .where({ id: existing.id })
      .update(data)
      .returning('*');
    return row;
  }
  const [row] = await db('novelty_results')
    .insert({ novelty_event_id: noveltyEventId, ...data })
    .returning('*');
  return row;
}

async function remove(db, id) {
  await db('novelty_results').where({ novelty_event_id: id }).delete();
  await db('novelty_events').where({ id }).delete();
}

module.exports = { findByEventDay, create, findResult, setResult, remove };
