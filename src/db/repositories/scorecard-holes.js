'use strict';

async function findByScorecard(db, scorecardId) {
  return db('scorecard_holes')
    .where({ scorecard_id: scorecardId })
    .orderBy('hole_number');
}

// Optimistic concurrency: rejects if stored version doesn't match expectedVersion.
// Pass expectedVersion=null to skip the check (initial insert path).
async function upsert(db, scorecardId, holeNumber, data, expectedVersion = null) {
  return db.transaction(async (trx) => {
    const existing = await trx('scorecard_holes')
      .where({ scorecard_id: scorecardId, hole_number: holeNumber })
      .first();

    if (!existing) {
      const [row] = await trx('scorecard_holes')
        .insert({ scorecard_id: scorecardId, hole_number: holeNumber, ...data, version: 1 })
        .returning('*');
      return row;
    }

    if (expectedVersion !== null && existing.version !== expectedVersion) {
      const err = new Error('Version conflict');
      err.code = 'VERSION_CONFLICT';
      err.currentVersion = existing.version;
      throw err;
    }

    const [row] = await trx('scorecard_holes')
      .where({ id: existing.id })
      .update({ ...data, version: existing.version + 1 })
      .returning('*');
    return row;
  });
}

module.exports = { findByScorecard, upsert };
