'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestDb, seedTenantAndOwner, seedEvent } = require('../helpers/pg');
const {
  calculateStablefordLeaderboards,
  countbackMetrics,
  buildChampionshipBoard,
} = require('../../src/services/scoring/stableford-leaderboard.service');

async function withDb(run) {
  const db = await createTestDb();
  try {
    await run(db);
  } finally {
    await db.destroy();
  }
}

// Helper — build a pointsByHole Map from an array of [hole, points] pairs
function pointsMap(entries) {
  return new Map(entries.map(([h, p]) => [h, p]));
}

test('stableford leaderboard applies countback last-9/6/3/1 for day ties', async () => {
  await withDb(async (db) => {
    const ts = Date.now();
    const { tenant } = await seedTenantAndOwner(db, { slug: `stableford-cb-${ts}` });
    const tour = await seedEvent(db, tenant.id, { year: 2035 });

    const [userA] = await db('users').insert({
      first_name: 'Phil', last_name: 'Kells', email: `cb.a.${ts}@test.local`,
    }).returning('*');
    const [userB] = await db('users').insert({
      first_name: 'Ben', last_name: 'Smith', email: `cb.b.${ts}@test.local`,
    }).returning('*');

    await db('event_players').insert([
      { tour_id: tour.id, user_id: userA.id, status: 'active' },
      { tour_id: tour.id, user_id: userB.id, status: 'active' },
    ]);

    const [groupId] = await db('tee_groups').insert({
      tour_id: tour.id, round_number: 2, tee_time: '08:00',
      tee_location: '1st tee', starting_hole: 1, group_number: 1, source: 'manual',
    }).returning('id').then((rows) => [rows[0].id]);

    await db('tee_group_players').insert([
      { tee_group_id: groupId, user_id: userA.id, position: 1 },
      { tee_group_id: groupId, user_id: userB.id, position: 2 },
    ]);

    const [scorecardA] = await db('scorecards').insert({
      tour_id: tour.id, round_number: 2, type: 'individual', user_id: userA.id, status: 'submitted',
    }).returning('*');
    const [scorecardB] = await db('scorecards').insert({
      tour_id: tour.id, round_number: 2, type: 'individual', user_id: userB.id, status: 'submitted',
    }).returning('*');

    const rows = [];
    for (let hole = 1; hole <= 18; hole += 1) {
      const aPoints = hole <= 9 ? 1 : 3; // total 36, strong back nine (holes 10-18)
      const bPoints = hole <= 9 ? 3 : 1; // total 36, weak back nine
      rows.push({ scorecard_id: scorecardA.id, hole_number: hole, gross_score: 5, stableford_points: aPoints, owner_user_id: userA.id });
      rows.push({ scorecard_id: scorecardB.id, hole_number: hole, gross_score: 5, stableford_points: bPoints, owner_user_id: userB.id });
    }
    await db('scorecard_holes').insert(rows);

    const boards = await calculateStablefordLeaderboards(db, tour.id, { roundNumbers: [2] });
    const round2 = boards.byDay[2];
    assert.equal(round2.length, 2);
    assert.equal(Number(round2[0].total), 36);
    assert.equal(Number(round2[1].total), 36);
    assert.equal(round2[0].name, 'Phil Kells');
    assert.equal(round2[1].name, 'Ben Smith');
    assert.ok(Number(round2[0].countbackLast9) > Number(round2[1].countbackLast9));
  });
});

// Pure unit tests for countback — no DB required

test('countbackMetrics uses absolute holes 10-18 regardless of where play starts', () => {
  // Both players start on hole 10 (shotgun split). Same scores on holes 10-18.
  // The old relative logic would have produced different results if starting hole != 1.
  const p = pointsMap([
    [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2],
    [10, 3], [11, 3], [12, 3], [13, 3], [14, 3], [15, 3], [16, 3], [17, 3], [18, 3],
  ]);
  const m = countbackMetrics(p);
  // holes 10-18 = 9 * 3 = 27
  assert.equal(m.last9, 27);
  // holes 13-18 = 6 * 3 = 18
  assert.equal(m.last6, 18);
  // holes 16-18 = 3 * 3 = 9
  assert.equal(m.last3, 9);
  // hole 18 = 3
  assert.equal(m.last1, 3);
});

test('countbackMetrics: scores only on front nine give zero countback', () => {
  const p = pointsMap([
    [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [9, 4],
  ]);
  const m = countbackMetrics(p);
  assert.equal(m.last9, 0);
  assert.equal(m.last6, 0);
  assert.equal(m.last3, 0);
  assert.equal(m.last1, 0);
});

test('buildChampionshipBoard sums all rounds when bestOf not set', () => {
  const dayBoards = {
    1: [{ userId: 1, name: 'Alice', total: 30, countbackLast9: 15, countbackLast6: 10, countbackLast3: 5, countbackLast1: 2, position: 1 }],
    2: [{ userId: 1, name: 'Alice', total: 28, countbackLast9: 13, countbackLast6:  8, countbackLast3: 4, countbackLast1: 1, position: 1 }],
  };
  const board = buildChampionshipBoard(dayBoards, [1, 2], undefined);
  assert.equal(board.length, 1);
  assert.equal(board[0].total, 58);
  assert.equal(board[0].countbackLast9, 28);
});

test('buildChampionshipBoard respects bestOf — drops worst round from total and countback', () => {
  // 3 rounds, bestOf=2 — the worst round (20) should be excluded
  const dayBoards = {
    1: [{ userId: 1, name: 'Alice', total: 30, countbackLast9: 15, countbackLast6: 10, countbackLast3: 5, countbackLast1: 2, position: 1 }],
    2: [{ userId: 1, name: 'Alice', total: 28, countbackLast9: 13, countbackLast6:  8, countbackLast3: 4, countbackLast1: 1, position: 1 }],
    3: [{ userId: 1, name: 'Alice', total: 20, countbackLast9:  9, countbackLast6:  5, countbackLast3: 2, countbackLast1: 1, position: 1 }],
  };
  const board = buildChampionshipBoard(dayBoards, [1, 2, 3], 2);
  assert.equal(board.length, 1);
  // Only rounds with totals 30 + 28 = 58 count; round with 20 is dropped
  assert.equal(board[0].total, 58);
  // Countback: only the two best rounds summed (15+13=28, not 15+13+9=37)
  assert.equal(board[0].countbackLast9, 28);
});

test('buildChampionshipBoard bestOf tie-breaking excludes dropped rounds countback', () => {
  // Player A: rounds 30, 29, 10 (best 2 = 59, countback from rounds 30+29)
  // Player B: rounds 30, 29, 10 identical totals — alphabetical tiebreak
  // Player C: rounds 30, 28, 10 (best 2 = 58)
  const dayBoards = {
    1: [
      { userId: 1, name: 'Alice', total: 30, countbackLast9: 15, countbackLast6: 10, countbackLast3: 5, countbackLast1: 2, position: 1 },
      { userId: 2, name: 'Bob',   total: 30, countbackLast9: 14, countbackLast6:  9, countbackLast3: 4, countbackLast1: 1, position: 2 },
      { userId: 3, name: 'Carol', total: 30, countbackLast9: 12, countbackLast6:  8, countbackLast3: 3, countbackLast1: 1, position: 3 },
    ],
    2: [
      { userId: 1, name: 'Alice', total: 29, countbackLast9: 14, countbackLast6:  9, countbackLast3: 4, countbackLast1: 2, position: 1 },
      { userId: 2, name: 'Bob',   total: 29, countbackLast9: 14, countbackLast6:  9, countbackLast3: 4, countbackLast1: 2, position: 1 },
      { userId: 3, name: 'Carol', total: 28, countbackLast9: 13, countbackLast6:  8, countbackLast3: 3, countbackLast1: 1, position: 3 },
    ],
    3: [
      { userId: 1, name: 'Alice', total: 10, countbackLast9: 5, countbackLast6: 3, countbackLast3: 2, countbackLast1: 1, position: 1 },
      { userId: 2, name: 'Bob',   total: 10, countbackLast9: 5, countbackLast6: 3, countbackLast3: 2, countbackLast1: 1, position: 1 },
      { userId: 3, name: 'Carol', total: 10, countbackLast9: 5, countbackLast6: 3, countbackLast3: 2, countbackLast1: 1, position: 3 },
    ],
  };
  const board = buildChampionshipBoard(dayBoards, [1, 2, 3], 2);
  assert.equal(board.length, 3);
  // Alice and Bob both have 59; Carol has 58
  assert.equal(board[0].total, 59);
  assert.equal(board[1].total, 59);
  assert.equal(board[2].total, 58);
  // Alice beats Bob on countback: Alice last9 = 15+14=29, Bob last9 = 14+14=28
  assert.equal(board[0].name, 'Alice');
  assert.equal(board[1].name, 'Bob');
  // Dropped rounds (total=10) must NOT contribute to countback
  assert.equal(board[0].countbackLast9, 29); // 15+14, not 15+14+5
  assert.equal(board[1].countbackLast9, 28); // 14+14, not 14+14+5
});
