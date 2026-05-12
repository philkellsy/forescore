'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestDb, seedTenantAndOwner, seedEvent } = require('../helpers/pg');
const { upsertHoleScore, ScoreConflictError } = require('../../src/services/scoring/score-entry.service');

// Creates the minimal fixture chain required by the FK constraints:
// tenant → event → users → scorecard
async function createFixture(db) {
  const ts = Date.now();
  const { tenant } = await seedTenantAndOwner(db, { slug: `score-entry-${ts}` });
  const event = await seedEvent(db, tenant.id);

  const [userA] = await db('users').insert({
    first_name: 'Phil',
    last_name: 'Kells',
    email: `score.a.${ts}@test.local`,
  }).returning('*');
  const [userB] = await db('users').insert({
    first_name: 'Ben',
    last_name: 'Smith',
    email: `score.b.${ts}@test.local`,
  }).returning('*');

  const [scorecard] = await db('scorecards').insert({
    tour_id: event.id,
    round_number: 1,
    type: 'individual',
    user_id: userA.id,
    status: 'draft',
  }).returning('*');

  return { scorecardId: scorecard.id, userAId: userA.id, userBId: userB.id };
}

function scorePayload(scorecardId, requesterUserId, overrides = {}) {
  return {
    scorecardId,
    holeNumber: 1,
    grossScore: 4,
    par: 4,
    strokeIndexPrimary: 7,
    strokeIndexSecondary: 19,
    playingHandicap: 8,
    requesterUserId,
    force: false,
    ...overrides,
  };
}

test('owner can update their own existing score without conflict', async () => {
  const db = await createTestDb();
  try {
    const { scorecardId, userAId } = await createFixture(db);
    await upsertHoleScore(db, scorePayload(scorecardId, userAId, { grossScore: 4 }));
    const result = await upsertHoleScore(db, scorePayload(scorecardId, userAId, { grossScore: 5 }));

    assert.equal(result.grossScore, 5);
    const row = await db('scorecard_holes').where({ scorecard_id: scorecardId, hole_number: 1 }).first();
    assert.equal(Number(row.gross_score), 5);
    assert.equal(Number(row.owner_user_id), userAId);
  } finally {
    await db.destroy();
  }
});

test('non-owner write returns ScoreConflictError with canonical owner info', async () => {
  const db = await createTestDb();
  try {
    const { scorecardId, userAId, userBId } = await createFixture(db);
    await upsertHoleScore(db, scorePayload(scorecardId, userAId, { grossScore: 5 }));

    await assert.rejects(
      upsertHoleScore(db, scorePayload(scorecardId, userBId, { grossScore: 4 })),
      (error) => {
        assert.ok(error instanceof ScoreConflictError);
        assert.equal(error.payload.canonicalGross, 5);
        assert.equal(Number(error.payload.ownerUserId), userAId);
        assert.equal(error.payload.ownerName, 'Phil K.');
        return true;
      }
    );
  } finally {
    await db.destroy();
  }
});

test('force flag allows non-owner correction', async () => {
  const db = await createTestDb();
  try {
    const { scorecardId, userAId, userBId } = await createFixture(db);
    await upsertHoleScore(db, scorePayload(scorecardId, userAId, { grossScore: 5 }));
    const result = await upsertHoleScore(db, scorePayload(scorecardId, userBId, { grossScore: 4, force: true }));

    assert.equal(result.grossScore, 4);
    const row = await db('scorecard_holes').where({ scorecard_id: scorecardId, hole_number: 1 }).first();
    assert.equal(Number(row.gross_score), 4);
  } finally {
    await db.destroy();
  }
});

test('non-owner clear (gross 0) returns conflict', async () => {
  const db = await createTestDb();
  try {
    const { scorecardId, userAId, userBId } = await createFixture(db);
    await upsertHoleScore(db, scorePayload(scorecardId, userAId, { grossScore: 5 }));

    await assert.rejects(
      upsertHoleScore(db, scorePayload(scorecardId, userBId, { grossScore: 0 })),
      (error) => error instanceof ScoreConflictError
    );
  } finally {
    await db.destroy();
  }
});
