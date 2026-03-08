'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('knex');

const { bootstrap } = require('../../src/bootstrap');
const { calculateStablefordLeaderboards } = require('../../src/services/scoring/stableford-leaderboard.service');
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

test('stableford leaderboard applies countback last-9/6/3/1 for day ties', async () => {
  await withDb(async (db) => {
    const [userAId] = await db('users').insert({
      first_name: 'Phil',
      last_name: 'Kells',
      email: 'cb.a@test.local',
      role: ROLES.PLAYER
    });
    const [userBId] = await db('users').insert({
      first_name: 'Ben',
      last_name: 'Smith',
      email: 'cb.b@test.local',
      role: ROLES.PLAYER
    });

    const [eventId] = await db('events').insert({
      year: 2035,
      location: 'Bonville International Golf Resort',
      start_date: '2035-02-01',
      end_date: '2035-02-04',
      is_active: 1
    });

    await db('event_players').insert([
      { event_id: eventId, user_id: userAId, status: 'active', is_previous_year_winner: 0 },
      { event_id: eventId, user_id: userBId, status: 'active', is_previous_year_winner: 0 }
    ]);

    const [groupId] = await db('tee_groups').insert({
      event_id: eventId,
      day: 2,
      tee_time: '08:00',
      tee_location: '1st tee',
      starting_hole: 1,
      group_number: 1,
      source: 'manual'
    });
    await db('tee_group_players').insert([
      { tee_group_id: groupId, user_id: userAId, position: 1 },
      { tee_group_id: groupId, user_id: userBId, position: 2 }
    ]);

    const [scorecardAId] = await db('scorecards').insert({
      event_id: eventId,
      day: 2,
      type: 'individual',
      user_id: userAId,
      status: 'draft'
    });
    const [scorecardBId] = await db('scorecards').insert({
      event_id: eventId,
      day: 2,
      type: 'individual',
      user_id: userBId,
      status: 'draft'
    });

    const rows = [];
    for (let hole = 1; hole <= 18; hole += 1) {
      const aPoints = hole <= 9 ? 1 : 3; // total 36, strong back nine
      const bPoints = hole <= 9 ? 3 : 1; // total 36, weak back nine
      rows.push({
        scorecard_id: scorecardAId,
        hole_number: hole,
        gross_score: 5,
        stableford_points: aPoints,
        owner_user_id: userAId
      });
      rows.push({
        scorecard_id: scorecardBId,
        hole_number: hole,
        gross_score: 5,
        stableford_points: bPoints,
        owner_user_id: userBId
      });
    }
    await db('scorecard_holes').insert(rows);

    const boards = await calculateStablefordLeaderboards(db, eventId);
    const day2 = boards.byDay[2];
    assert.equal(day2.length, 2);
    assert.equal(Number(day2[0].total), 36);
    assert.equal(Number(day2[1].total), 36);
    assert.equal(day2[0].name, 'Phil Kells');
    assert.equal(day2[1].name, 'Ben Smith');
    assert.ok(Number(day2[0].countbackLast9) > Number(day2[1].countbackLast9));
  });
});
