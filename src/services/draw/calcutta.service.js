'use strict';

function randomizePlayers(playerIds) {
  const arr = [...playerIds];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function createDay2Order(db, eventId) {
  return db('calcutta_auctions')
    .where({ event_id: eventId })
    .orderBy('draw_order', 'asc');
}

module.exports = { randomizePlayers, createDay2Order };
