'use strict';

async function getActiveEvent(db) {
  return db('events').where({ is_active: 1 }).first();
}

module.exports = { getActiveEvent };
