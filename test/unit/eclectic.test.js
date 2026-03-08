'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('knex');

const { bootstrap } = require('../../src/bootstrap');
const { calculateEclecticLeaderboard } = require('../../src/services/scoring/eclectic.service');
const { ROLES } = require('../../src/config/roles');

async function withDb(run) {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  });

  try {
    await bootstrap(db);
    await run(db);
  } finally {
    await db.destroy();
  }
}

test('eclectic uses best stableford per hole across rounds 1-3 (days 2-4)', async () => {
  await withDb(async (db) => {
    const [userAId] = await db('users').insert({
      first_name: 'Alice',
      last_name: 'Driver',
      email: 'eclectic.a@test.local',
      role: ROLES.PLAYER
    });
    const [userBId] = await db('users').insert({
      first_name: 'Bob',
      last_name: 'Fairway',
      email: 'eclectic.b@test.local',
      role: ROLES.PLAYER
    });

    const [eventId] = await db('events').insert({
      year: 2036,
      location: 'Bonville International Golf Resort',
      start_date: '2036-02-01',
      end_date: '2036-02-04',
      is_active: 1
    });

    await db('event_players').insert([
      { event_id: eventId, user_id: userAId, status: 'active', is_previous_year_winner: 0 },
      { event_id: eventId, user_id: userBId, status: 'active', is_previous_year_winner: 0 }
    ]);

    const scorecardIds = [];
    for (const day of [2, 3, 4]) {
      const [aId] = await db('scorecards').insert({
        event_id: eventId,
        day,
        type: 'individual',
        user_id: userAId,
        status: 'submitted'
      });
      const [bId] = await db('scorecards').insert({
        event_id: eventId,
        day,
        type: 'individual',
        user_id: userBId,
        status: 'submitted'
      });
      scorecardIds.push({ day, aId: Number(aId), bId: Number(bId) });
    }

    const rows = [];
    for (let hole = 1; hole <= 18; hole += 1) {
      const aPointsByDay = { 2: 2, 3: 3, 4: 1 }; // best = 3 per hole
      const bPointsByDay = { 2: 2, 3: 1, 4: 2 }; // best = 2 per hole
      for (const { day, aId, bId } of scorecardIds) {
        rows.push({
          scorecard_id: aId,
          hole_number: hole,
          gross_score: 5,
          stableford_points: Number(aPointsByDay[day]),
          owner_user_id: userAId
        });
        rows.push({
          scorecard_id: bId,
          hole_number: hole,
          gross_score: 5,
          stableford_points: Number(bPointsByDay[day]),
          owner_user_id: userBId
        });
      }
    }
    await db('scorecard_holes').insert(rows);

    const board = await calculateEclecticLeaderboard(db, eventId);
    assert.equal(board.length, 2);
    assert.equal(board[0].name, 'Alice Driver');
    assert.equal(Number(board[0].totalPoints), 54); // 18 holes * best 3
    assert.equal(board[1].name, 'Bob Fairway');
    assert.equal(Number(board[1].totalPoints), 36); // 18 holes * best 2
  });
});
