'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const knex = require('knex');

const { bootstrap } = require('../../src/bootstrap');
const { createApp } = require('../../src/app');
const { createLoginCode } = require('../../src/services/auth/login-code.service');
const { ROLES } = require('../../src/config/roles');

async function createDb() {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  });
  await bootstrap(db);
  return db;
}

function extractSessionCookie(setCookieHeader) {
  if (!setCookieHeader) return '';
  return String(setCookieHeader).split(';')[0].trim();
}

async function loginWithCode(baseUrl, db, userId) {
  const user = await db('users').where({ id: userId }).first();
  assert.ok(user, 'expected user for login helper');
  const { code } = await createLoginCode(db, userId, '127.0.0.1', 'integration-test');
  const body = new URLSearchParams({
    lookup: user.email,
    code
  });
  const res = await fetch(`${baseUrl}/auth/verify-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  return extractSessionCookie(res.headers.get('set-cookie'));
}

test('confirm submit finalizes all scorecards in the individual group', async () => {
  const db = await createDb();
  const app = createApp({ db, sessionStore: new session.MemoryStore() });
  const server = app.listen(0);

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const [userAId] = await db('users').insert({
      first_name: 'Phil',
      last_name: 'Kells',
      email: 'submit.group.a@test.local',
      role: ROLES.PLAYER
    });
    const [userBId] = await db('users').insert({
      first_name: 'Ben',
      last_name: 'Smith',
      email: 'submit.group.b@test.local',
      role: ROLES.PLAYER
    });

    const [eventId] = await db('events').insert({
      year: 2033,
      location: 'Bonville International Golf Resort',
      start_date: '2033-02-01',
      end_date: '2033-02-04',
      is_active: 1
    });

    const [courseId] = await db('courses').insert({
      course_name: 'Bonville',
      tee_name: 'Bloodwood'
    });
    await db('holes').insert({
      course_id: courseId,
      hole_number: 1,
      par: 4,
      stroke_index_primary: 7,
      stroke_index_secondary: 19
    });
    await db('event_day_statuses').insert({
      event_id: eventId,
      day: 2,
      status: 'open_scoring',
      course_id: courseId
    });

    await db('event_players').insert([
      { event_id: eventId, user_id: userAId, status: 'active' },
      { event_id: eventId, user_id: userBId, status: 'active' }
    ]);
    await db('player_handicaps').insert([
      { event_id: eventId, user_id: userAId, playing_handicap: 8 },
      { event_id: eventId, user_id: userBId, playing_handicap: 10 }
    ]);

    const [teeGroupId] = await db('tee_groups').insert({
      event_id: eventId,
      day: 2,
      tee_time: '08:00',
      tee_location: '1st tee',
      starting_hole: 1,
      group_number: 1,
      source: 'manual'
    });
    await db('tee_group_players').insert([
      { tee_group_id: teeGroupId, user_id: userAId, position: 1 },
      { tee_group_id: teeGroupId, user_id: userBId, position: 2 }
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

    const holeRows = [];
    for (let hole = 1; hole <= 18; hole += 1) {
      holeRows.push({ scorecard_id: scorecardAId, hole_number: hole, gross_score: 5, stableford_points: 2, owner_user_id: userAId });
      holeRows.push({ scorecard_id: scorecardBId, hole_number: hole, gross_score: 5, stableford_points: 2, owner_user_id: userBId });
    }
    await db('scorecard_holes').insert(holeRows);

    const cookieA = await loginWithCode(baseUrl, db, Number(userAId));

    const confirmRes = await fetch(`${baseUrl}/scoring/confirm/${scorecardAId}/final`, {
      headers: { cookie: cookieA }
    });
    assert.equal(confirmRes.status, 200);
    const confirmHtml = await confirmRes.text();
    const snapshotMatch = confirmHtml.match(/data-submit-snapshot="([a-f0-9]+)"/i);
    assert.ok(snapshotMatch, 'expected submit snapshot token in confirm page');
    const submitSnapshot = snapshotMatch[1];

    const submitRes = await fetch(`${baseUrl}/scoring/confirm/${scorecardAId}/submit`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ submitSnapshot })
    });
    assert.equal(submitRes.status, 200);
    const submitBody = await submitRes.json();
    assert.equal(submitBody.ok, true);
    assert.equal(submitBody.redirect, '/scoring?message=Group%20scores%20submitted%20successfully');

    const statuses = await db('scorecards')
      .whereIn('id', [scorecardAId, scorecardBId])
      .orderBy('id', 'asc')
      .select('id', 'status');
    assert.equal(statuses.length, 2);
    assert.equal(statuses[0].status, 'submitted');
    assert.equal(statuses[1].status, 'submitted');

    const submitAgainRes = await fetch(`${baseUrl}/scoring/confirm/${scorecardAId}/submit`, {
      method: 'POST',
      headers: { Accept: 'application/json', cookie: cookieA }
    });
    assert.equal(submitAgainRes.status, 409);
    const submitAgainBody = await submitAgainRes.json();
    assert.equal(submitAgainBody.error, 'already_finalized');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.destroy();
  }
});

test('confirm submit rejects when group scores changed after confirmation snapshot', async () => {
  const db = await createDb();
  const app = createApp({ db, sessionStore: new session.MemoryStore() });
  const server = app.listen(0);

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const [userAId] = await db('users').insert({
      first_name: 'Phil',
      last_name: 'Kells',
      email: 'submit.stale.a@test.local',
      role: ROLES.PLAYER
    });
    const [userBId] = await db('users').insert({
      first_name: 'Ben',
      last_name: 'Smith',
      email: 'submit.stale.b@test.local',
      role: ROLES.PLAYER
    });

    const [eventId] = await db('events').insert({
      year: 2034,
      location: 'Bonville International Golf Resort',
      start_date: '2034-02-01',
      end_date: '2034-02-04',
      is_active: 1
    });

    const [courseId] = await db('courses').insert({
      course_name: 'Bonville',
      tee_name: 'Bloodwood'
    });
    await db('holes').insert({
      course_id: courseId,
      hole_number: 1,
      par: 4,
      stroke_index_primary: 7,
      stroke_index_secondary: 19
    });
    await db('event_day_statuses').insert({
      event_id: eventId,
      day: 2,
      status: 'open_scoring',
      course_id: courseId
    });

    await db('event_players').insert([
      { event_id: eventId, user_id: userAId, status: 'active' },
      { event_id: eventId, user_id: userBId, status: 'active' }
    ]);
    await db('player_handicaps').insert([
      { event_id: eventId, user_id: userAId, playing_handicap: 8 },
      { event_id: eventId, user_id: userBId, playing_handicap: 10 }
    ]);

    const [teeGroupId] = await db('tee_groups').insert({
      event_id: eventId,
      day: 2,
      tee_time: '08:00',
      tee_location: '1st tee',
      starting_hole: 1,
      group_number: 1,
      source: 'manual'
    });
    await db('tee_group_players').insert([
      { tee_group_id: teeGroupId, user_id: userAId, position: 1 },
      { tee_group_id: teeGroupId, user_id: userBId, position: 2 }
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

    const holeRows = [];
    for (let hole = 1; hole <= 18; hole += 1) {
      holeRows.push({ scorecard_id: scorecardAId, hole_number: hole, gross_score: 5, stableford_points: 2, owner_user_id: userAId });
      holeRows.push({ scorecard_id: scorecardBId, hole_number: hole, gross_score: 5, stableford_points: 2, owner_user_id: userBId });
    }
    await db('scorecard_holes').insert(holeRows);

    const cookieA = await loginWithCode(baseUrl, db, Number(userAId));

    const confirmRes = await fetch(`${baseUrl}/scoring/confirm/${scorecardAId}/final`, {
      headers: { cookie: cookieA }
    });
    assert.equal(confirmRes.status, 200);
    const confirmHtml = await confirmRes.text();
    const snapshotMatch = confirmHtml.match(/data-submit-snapshot="([a-f0-9]+)"/i);
    assert.ok(snapshotMatch, 'expected submit snapshot token in confirm page');
    const submitSnapshot = snapshotMatch[1];

    // Simulate another scorer changing a score after confirmation view was loaded.
    await db('scorecard_holes')
      .where({ scorecard_id: scorecardBId, hole_number: 1 })
      .update({ gross_score: 6, stableford_points: 1, updated_at: db.fn.now() });

    const submitRes = await fetch(`${baseUrl}/scoring/confirm/${scorecardAId}/submit`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ submitSnapshot })
    });
    assert.equal(submitRes.status, 409);
    const submitBody = await submitRes.json();
    assert.equal(submitBody.error, 'stale_scores');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.destroy();
  }
});
