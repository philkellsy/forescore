'use strict';

async function findByEvent(db, eventId) {
  return db('event_day_statuses').where({ event_id: eventId }).orderBy('day');
}

async function findByDay(db, eventId, day) {
  return db('event_day_statuses').where({ event_id: eventId, day }).first();
}

async function upsert(db, data) {
  const { event_id, day, ...rest } = data;
  const existing = await findByDay(db, event_id, day);
  if (existing) {
    const [row] = await db('event_day_statuses')
      .where({ id: existing.id })
      .update(rest)
      .returning('*');
    return row;
  }
  const [row] = await db('event_day_statuses').insert(data).returning('*');
  return row;
}

async function updateStatus(db, eventId, day, status) {
  const [row] = await db('event_day_statuses')
    .where({ event_id: eventId, day })
    .update({ status })
    .returning('*');
  return row;
}

async function setPublished(db, eventId, day, published) {
  const [row] = await db('event_day_statuses')
    .where({ event_id: eventId, day })
    .update({ leaderboard_published: published })
    .returning('*');
  return row;
}

module.exports = { findByEvent, findByDay, upsert, updateStatus, setPublished };
