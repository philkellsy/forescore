'use strict';

// Returns players joined with user name/email for display
async function findByEvent(db, tourId) {
  return db('event_players as ep')
    .join('users as u', 'u.id', 'ep.user_id')
    .where('ep.tour_id', tourId)
    .select('ep.*', 'u.first_name', 'u.last_name', 'u.email', 'u.phone_number')
    .orderBy(['u.first_name', 'u.last_name']);
}

async function findByEventAndUser(db, tourId, userId) {
  return db('event_players').where({ tour_id: tourId, user_id: userId }).first();
}

async function register(db, data) {
  const [row] = await db('event_players').insert(data).returning('*');
  return row;
}

async function updateStatus(db, id, status) {
  const [row] = await db('event_players').where({ id }).update({ status }).returning('*');
  return row;
}

module.exports = {
  findByEvent,
  findByEventAndUser,
  register,
  updateStatus,
};
