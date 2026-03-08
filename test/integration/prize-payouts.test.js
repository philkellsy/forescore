'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const knex = require('knex');

const { bootstrap } = require('../../src/bootstrap');
const { createApp } = require('../../src/app');
const { createLoginToken } = require('../../src/services/auth/magic-link.service');
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

async function loginWithMagicLink(baseUrl, db, userId) {
  const { token } = await createLoginToken(db, userId, '127.0.0.1', 'integration-test');
  const res = await fetch(`${baseUrl}/auth/verify?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return extractSessionCookie(res.headers.get('set-cookie'));
}

async function seed18Holes(db, courseId) {
  const rows = [];
  for (let hole = 1; hole <= 18; hole += 1) {
    rows.push({
      course_id: courseId,
      hole_number: hole,
      par: 4,
      stroke_index_primary: hole,
      stroke_index_secondary: hole + 18
    });
  }
  await db('holes').insert(rows);
}

test('player dashboard shows open scorecard chip and published prize winnings', async () => {
  const db = await createDb();
  const app = createApp({ db, sessionStore: new session.MemoryStore() });
  const server = app.listen(0);

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const [userAId] = await db('users').insert({
      first_name: 'Phil',
      last_name: 'Kells',
      email: 'player.prizes.a@test.local',
      role: ROLES.PLAYER
    });
    const [userBId] = await db('users').insert({
      first_name: 'Ben',
      last_name: 'Smith',
      email: 'player.prizes.b@test.local',
      role: ROLES.PLAYER
    });
    const [eventId] = await db('events').insert({
      year: 2040,
      location: 'Bonville International Golf Resort',
      start_date: '2040-02-01',
      end_date: '2040-02-04',
      is_active: 1,
      prize_daily_winner_amount: 20,
      prize_daily_second_amount: 10,
      skins_amount_per_player_per_hole: 1
    });
    const [courseId] = await db('courses').insert({
      course_name: 'Bonville',
      tee_name: 'Bloodwood'
    });
    await seed18Holes(db, Number(courseId));

    await db('event_players').insert([
      { event_id: eventId, user_id: userAId, status: 'active' },
      { event_id: eventId, user_id: userBId, status: 'active' }
    ]);
    await db('player_handicaps').insert([
      { event_id: eventId, user_id: userAId, playing_handicap: 8 },
      { event_id: eventId, user_id: userBId, playing_handicap: 10 }
    ]);

    await db('event_day_statuses').insert([
      { event_id: eventId, day: 2, status: 'open_scoring', leaderboard_published: 1, course_id: courseId, calc_type: 'stableford' },
      { event_id: eventId, day: 3, status: 'open_scoring', leaderboard_published: 0, course_id: courseId, calc_type: 'stableford' }
    ]);

    const [day2GroupId] = await db('tee_groups').insert({
      event_id: eventId,
      day: 2,
      tee_time: '08:00',
      tee_location: '1st tee',
      starting_hole: 1,
      group_number: 1,
      source: 'manual'
    });
    const [day3GroupId] = await db('tee_groups').insert({
      event_id: eventId,
      day: 3,
      tee_time: '08:10',
      tee_location: '1st tee',
      starting_hole: 1,
      group_number: 1,
      source: 'manual'
    });
    await db('tee_group_players').insert([
      { tee_group_id: day2GroupId, user_id: userAId, position: 1 },
      { tee_group_id: day2GroupId, user_id: userBId, position: 2 },
      { tee_group_id: day3GroupId, user_id: userAId, position: 1 },
      { tee_group_id: day3GroupId, user_id: userBId, position: 2 }
    ]);

    const [day2ScoreA] = await db('scorecards').insert({
      event_id: eventId,
      day: 2,
      type: 'individual',
      user_id: userAId,
      status: 'submitted'
    });
    const [day2ScoreB] = await db('scorecards').insert({
      event_id: eventId,
      day: 2,
      type: 'individual',
      user_id: userBId,
      status: 'submitted'
    });
    const [day3ScoreA] = await db('scorecards').insert({
      event_id: eventId,
      day: 3,
      type: 'individual',
      user_id: userAId,
      status: 'draft'
    });

    const day2Rows = [];
    for (let hole = 1; hole <= 18; hole += 1) {
      day2Rows.push({ scorecard_id: day2ScoreA, hole_number: hole, gross_score: 4, stableford_points: 3, owner_user_id: userAId });
      day2Rows.push({ scorecard_id: day2ScoreB, hole_number: hole, gross_score: 5, stableford_points: 2, owner_user_id: userBId });
    }
    await db('scorecard_holes').insert(day2Rows);

    const cookieA = await loginWithMagicLink(baseUrl, db, Number(userAId));
    const res = await fetch(`${baseUrl}/player/dashboard`, { headers: { cookie: cookieA } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Open Scorecards/i);
    assert.match(html, new RegExp(`/scoring/live/${Number(day3ScoreA)}`));
    assert.match(html, /Prize Winnings/i);
    assert.match(html, /Daily Winner/i);
    assert.match(html, /\$20\.00/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.destroy();
  }
});

test('presentation sheet includes daily payout schedule with configured amounts', async () => {
  const db = await createDb();
  const app = createApp({ db, sessionStore: new session.MemoryStore() });
  const server = app.listen(0);

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const [adminId] = await db('users').insert({
      first_name: 'Admin',
      last_name: 'User',
      email: 'admin.presentation@test.local',
      role: ROLES.ADMIN
    });
    const [userAId] = await db('users').insert({
      first_name: 'Phil',
      last_name: 'Kells',
      email: 'admin.presentation.a@test.local',
      role: ROLES.PLAYER
    });
    const [userBId] = await db('users').insert({
      first_name: 'Ben',
      last_name: 'Smith',
      email: 'admin.presentation.b@test.local',
      role: ROLES.PLAYER
    });
    const [eventId] = await db('events').insert({
      year: 2041,
      location: 'Bonville International Golf Resort',
      start_date: '2041-02-01',
      end_date: '2041-02-04',
      is_active: 1,
      prize_daily_winner_amount: 35,
      prize_daily_second_amount: 15
    });
    const [courseId] = await db('courses').insert({
      course_name: 'Bonville',
      tee_name: 'Bloodwood'
    });
    await seed18Holes(db, Number(courseId));
    await db('event_day_statuses').insert({
      event_id: eventId,
      day: 2,
      status: 'open_scoring',
      leaderboard_published: 0,
      course_id: courseId,
      calc_type: 'stableford'
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
    const [scoreA] = await db('scorecards').insert({
      event_id: eventId,
      day: 2,
      type: 'individual',
      user_id: userAId,
      status: 'submitted'
    });
    const [scoreB] = await db('scorecards').insert({
      event_id: eventId,
      day: 2,
      type: 'individual',
      user_id: userBId,
      status: 'submitted'
    });
    const rows = [];
    for (let hole = 1; hole <= 18; hole += 1) {
      rows.push({ scorecard_id: scoreA, hole_number: hole, gross_score: 4, stableford_points: 3, owner_user_id: userAId });
      rows.push({ scorecard_id: scoreB, hole_number: hole, gross_score: 5, stableford_points: 2, owner_user_id: userBId });
    }
    await db('scorecard_holes').insert(rows);

    const adminCookie = await loginWithMagicLink(baseUrl, db, Number(adminId));
    const res = await fetch(`${baseUrl}/admin/events/${Number(eventId)}/presentation-sheet?day=2`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Daily Payout Schedule/i);
    assert.match(html, /Daily<\/td>\s*<td>Phil Kells<\/td>\s*<td>Winner<\/td>\s*<td><strong>\$35\.00<\/strong>/i);
    assert.match(html, /Day Total:\s*\$50\.00/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.destroy();
  }
});

test('setup prizes validation uses Owner Daily Winner percent x3 rule', async () => {
  const db = await createDb();
  const app = createApp({ db, sessionStore: new session.MemoryStore() });
  const server = app.listen(0);

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const [adminId] = await db('users').insert({
      first_name: 'Admin',
      last_name: 'User',
      email: 'admin.prizes.validation@test.local',
      role: ROLES.ADMIN
    });
    const [eventId] = await db('events').insert({
      year: 2042,
      location: 'Bonville International Golf Resort',
      start_date: '2042-02-01',
      end_date: '2042-02-04',
      is_active: 1
    });
    const [courseId] = await db('courses').insert({
      course_name: 'Bonville',
      tee_name: 'Bloodwood'
    });
    await seed18Holes(db, Number(courseId));
    await db('event_day_statuses').insert([
      { event_id: eventId, day: 1, status: 'draft', leaderboard_published: 0, course_id: courseId, calc_type: 'ambrose_nett' },
      { event_id: eventId, day: 2, status: 'draft', leaderboard_published: 0, course_id: courseId, calc_type: 'stableford' },
      { event_id: eventId, day: 3, status: 'draft', leaderboard_published: 0, course_id: courseId, calc_type: 'stableford' },
      { event_id: eventId, day: 4, status: 'draft', leaderboard_published: 0, course_id: courseId, calc_type: 'stableford' }
    ]);

    const adminCookie = await loginWithMagicLink(baseUrl, db, Number(adminId));

    const goodRes = await fetch(`${baseUrl}/admin/events/${Number(eventId)}/setup/prizes`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/x-www-form-urlencoded'
      },
      redirect: 'manual',
      body: new URLSearchParams({
        calcuttaOwnerDailyWinnerPercent: '5',
        calcuttaChampionPercent: '10',
        calcuttaChampionOwnerPercent: '70',
        calcuttaMysteryPlacePercent: '5'
      }).toString()
    });
    assert.equal(goodRes.status, 302);
    assert.match(String(goodRes.headers.get('location') || ''), /message=Prize%20config%20updated/);

    const badRes = await fetch(`${baseUrl}/admin/events/${Number(eventId)}/setup/prizes`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/x-www-form-urlencoded'
      },
      redirect: 'manual',
      body: new URLSearchParams({
        calcuttaOwnerDailyWinnerPercent: '5',
        calcuttaChampionPercent: '10',
        calcuttaChampionOwnerPercent: '70',
        calcuttaMysteryPlacePercent: '4'
      }).toString()
    });
    assert.equal(badRes.status, 302);
    assert.match(String(badRes.headers.get('location') || ''), /error=Calcutta%20percentages%20must%20total%20100%25/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.destroy();
  }
});

