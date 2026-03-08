'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('knex');

const { upsertHoleScore, ScoreConflictError } = require('../../src/services/scoring/score-entry.service');

async function withDb(run) {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  });

  await db.schema.createTable('users', (table) => {
    table.increments('id').primary();
    table.string('first_name');
    table.string('last_name');
  });

  await db.schema.createTable('scorecard_holes', (table) => {
    table.increments('id').primary();
    table.integer('scorecard_id').notNullable();
    table.integer('hole_number').notNullable();
    table.integer('gross_score');
    table.integer('stableford_points');
    table.integer('owner_user_id');
    table.timestamp('updated_at').defaultTo(db.fn.now());
  });

  try {
    await run(db);
  } finally {
    await db.destroy();
  }
}

function scorePayload(overrides = {}) {
  return {
    scorecardId: 1,
    holeNumber: 1,
    grossScore: 4,
    par: 4,
    strokeIndexPrimary: 7,
    strokeIndexSecondary: 19,
    playingHandicap: 8,
    requesterUserId: 1,
    force: false,
    ...overrides
  };
}

test('owner can update their own existing score without conflict', async () => {
  await withDb(async (db) => {
    await db('users').insert([
      { id: 1, first_name: 'Phil', last_name: 'Kells' },
      { id: 2, first_name: 'Ben', last_name: 'Smith' }
    ]);

    await upsertHoleScore(db, scorePayload({ grossScore: 4, requesterUserId: 1 }));
    const result = await upsertHoleScore(db, scorePayload({ grossScore: 5, requesterUserId: 1 }));

    assert.equal(result.grossScore, 5);
    const row = await db('scorecard_holes').where({ scorecard_id: 1, hole_number: 1 }).first();
    assert.equal(Number(row.gross_score), 5);
    assert.equal(Number(row.owner_user_id), 1);
  });
});

test('non-owner write returns ScoreConflictError with canonical owner info', async () => {
  await withDb(async (db) => {
    await db('users').insert([
      { id: 1, first_name: 'Phil', last_name: 'Kells' },
      { id: 2, first_name: 'Ben', last_name: 'Smith' }
    ]);

    await upsertHoleScore(db, scorePayload({ grossScore: 5, requesterUserId: 1 }));

    await assert.rejects(
      upsertHoleScore(db, scorePayload({ grossScore: 4, requesterUserId: 2 })),
      (error) => {
        assert.ok(error instanceof ScoreConflictError);
        assert.equal(error.payload.canonicalGross, 5);
        assert.equal(error.payload.ownerUserId, 1);
        assert.equal(error.payload.ownerName, 'Phil K.');
        return true;
      }
    );
  });
});

test('force flag allows non-owner correction', async () => {
  await withDb(async (db) => {
    await db('users').insert([
      { id: 1, first_name: 'Phil', last_name: 'Kells' },
      { id: 2, first_name: 'Ben', last_name: 'Smith' }
    ]);

    await upsertHoleScore(db, scorePayload({ grossScore: 5, requesterUserId: 1 }));
    const result = await upsertHoleScore(
      db,
      scorePayload({ grossScore: 4, requesterUserId: 2, force: true })
    );

    assert.equal(result.grossScore, 4);
    const row = await db('scorecard_holes').where({ scorecard_id: 1, hole_number: 1 }).first();
    assert.equal(Number(row.gross_score), 4);
  });
});

test('non-owner clear (gross 0) returns conflict', async () => {
  await withDb(async (db) => {
    await db('users').insert([
      { id: 1, first_name: 'Phil', last_name: 'Kells' },
      { id: 2, first_name: 'Ben', last_name: 'Smith' }
    ]);

    await upsertHoleScore(db, scorePayload({ grossScore: 5, requesterUserId: 1 }));

    await assert.rejects(
      upsertHoleScore(db, scorePayload({ grossScore: 0, requesterUserId: 2 })),
      (error) => error instanceof ScoreConflictError
    );
  });
});
