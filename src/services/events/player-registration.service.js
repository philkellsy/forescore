'use strict';

async function listEventPlayers(db, eventId) {
  return db('event_players as ep')
    .join('users as u', 'u.id', 'ep.user_id')
    .where('ep.tour_id', eventId)
    .select('u.id', 'u.first_name', 'u.last_name', 'u.email', 'ep.status');
}

module.exports = { listEventPlayers };
