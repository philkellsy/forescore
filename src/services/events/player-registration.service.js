'use strict';

async function listEventPlayers(db, eventId) {
  return db('event_players as ep')
    .join('users as u', 'u.id', 'ep.user_id')
    .where('ep.event_id', eventId)
    .select('u.id', 'u.first_name', 'u.last_name', 'u.email', 'u.role');
}

module.exports = { listEventPlayers };
