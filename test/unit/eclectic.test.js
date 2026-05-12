'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestDb, seedTenantAndOwner, seedEvent } = require('../helpers/pg');
const { calculateEclecticLeaderboard } = require('../../src/services/scoring/eclectic.service');

async function withDb(run) {
  const db = await createTestDb();
  try {
    await run(db);
  } finally {
    await db.destroy();
  }
}

test('eclectic uses best stableford per hole across rounds 1-3', async () => {
  await withDb(async (db) => {
    const ts = Date.now();
    const { tenant } = await seedTenantAndOwner(db, { slug: `eclectic-${ts}` });
    const tour = await seedEvent(db, tenant.id, { year: 2036 });

    const [userA] = await db('users').insert({
      first_name: 'Alice', last_name: 'Driver', email: `eclectic.a.${ts}@test.local`,
    }).returning('*');
    const [userB] = await db('users').insert({
      first_name: 'Bob', last_name: 'Fairway', email: `eclectic.b.${ts}@test.local`,
    }).returning('*');

    await db('event_players').insert([
      { tour_id: tour.id, user_id: userA.id, status: 'active' },
      { tour_id: tour.id, user_id: userB.id, status: 'active' },
    ]);

    const scorecardIds = [];
    for (const roundNumber of [2, 3, 4]) {
      const [a] = await db('scorecards').insert({
        tour_id: tour.id, round_number: roundNumber, type: 'individual', user_id: userA.id, status: 'submitted',
      }).returning('*');
      const [b] = await db('scorecards').insert({
        tour_id: tour.id, round_number: roundNumber, type: 'individual', user_id: userB.id, status: 'submitted',
      }).returning('*');
      scorecardIds.push({ roundNumber, aId: a.id, bId: b.id });
    }

    const rows = [];
    for (let hole = 1; hole <= 18; hole += 1) {
      const aPointsByRound = { 2: 2, 3: 3, 4: 1 }; // best = 3 per hole
      const bPointsByRound = { 2: 2, 3: 1, 4: 2 }; // best = 2 per hole
      for (const { roundNumber, aId, bId } of scorecardIds) {
        rows.push({ scorecard_id: aId, hole_number: hole, gross_score: 5, stableford_points: aPointsByRound[roundNumber], owner_user_id: userA.id });
        rows.push({ scorecard_id: bId, hole_number: hole, gross_score: 5, stableford_points: bPointsByRound[roundNumber], owner_user_id: userB.id });
      }
    }
    await db('scorecard_holes').insert(rows);

    const board = await calculateEclecticLeaderboard(db, tour.id, [2, 3, 4]);
    assert.equal(board.length, 2);
    assert.equal(board[0].name, 'Alice Driver');
    assert.equal(Number(board[0].totalPoints), 54); // 18 holes * best 3
    assert.equal(board[1].name, 'Bob Fairway');
    assert.equal(Number(board[1].totalPoints), 36); // 18 holes * best 2
  });
});
