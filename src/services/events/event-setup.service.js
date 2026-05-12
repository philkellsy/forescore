'use strict';

async function getActiveEvent(db) {
  return db('tours').where({ status: 'active' }).first();
}

module.exports = { getActiveEvent };
