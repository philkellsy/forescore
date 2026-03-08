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
  const firstPart = String(setCookieHeader).split(';')[0];
  return firstPart.trim();
}

async function loginWithMagicLink(baseUrl, db, userId) {
  const { token } = await createLoginToken(db, userId, '127.0.0.1', 'integration-test');
  const res = await fetch(`${baseUrl}/auth/verify?token=${encodeURIComponent(token)}`, {
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  return extractSessionCookie(res.headers.get('set-cookie'));
}

async function seedAmbroseFixture({ db, baseUrl, suffix, year }) {
  const [philId] = await db('users').insert({
    first_name: 'Phil',
    last_name: 'Kells',
    email: `phil.${suffix}@test.local`,
    phone_number: '0404000000',
    role: ROLES.PLAYER
  });
  const [benId] = await db('users').insert({
    first_name: 'Ben',
    last_name: 'Smith',
    email: `ben.${suffix}@test.local`,
    phone_number: '0404000001',
    role: ROLES.PLAYER
  });

  const [eventId] = await db('events').insert({
    year,
    location: 'Bonville International Golf Resort',
    start_date: `${year}-02-01`,
    end_date: `${year}-02-04`,
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

  await db('event_players').insert([
    { event_id: eventId, user_id: philId, status: 'active', is_previous_year_winner: 0 },
    { event_id: eventId, user_id: benId, status: 'active', is_previous_year_winner: 0 }
  ]);
  await db('player_handicaps').insert([
    { event_id: eventId, user_id: philId, playing_handicap: 8 },
    { event_id: eventId, user_id: benId, playing_handicap: 10 }
  ]);
  await db('event_day_statuses').insert({
    event_id: eventId,
    day: 1,
    status: 'open_scoring',
    course_id: courseId
  });

  const [teeGroupId] = await db('tee_groups').insert({
    event_id: eventId,
    day: 1,
    tee_time: '08:00',
    tee_location: '1st',
    starting_hole: 1,
    group_number: 1,
    source: 'manual'
  });
  await db('tee_group_players').insert([
    { tee_group_id: teeGroupId, user_id: philId, position: 1 },
    { tee_group_id: teeGroupId, user_id: benId, position: 2 }
  ]);

  const [ambroseGroupId] = await db('ambrose_groups').insert({
    event_id: eventId,
    day: 1,
    group_number: 1,
    tee_time: '08:00',
    tee_location: '1st',
    starting_hole: 1
  });
  const [teamId] = await db('teams').insert({
    event_id: eventId,
    day: 1,
    competition_type: 'ambrose',
    name: 'Kells/Smith',
    ambrose_group_id: ambroseGroupId
  });
  await db('team_members').insert([
    { team_id: teamId, user_id: philId, is_dual_assigned: 0 },
    { team_id: teamId, user_id: benId, is_dual_assigned: 0 }
  ]);

  const [scorecardId] = await db('scorecards').insert({
    event_id: eventId,
    day: 1,
    type: 'team',
    team_id: teamId,
    status: 'draft'
  });

  const philCookie = await loginWithMagicLink(baseUrl, db, Number(philId));
  const benCookie = await loginWithMagicLink(baseUrl, db, Number(benId));

  return {
    scorecardId: Number(scorecardId),
    philCookie,
    benCookie
  };
}

test('ambrose live gross scoring enforces and resolves conflict over HTTP', async () => {
  const db = await createDb();
  const app = createApp({ db, sessionStore: new session.MemoryStore() });
  const server = app.listen(0);

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const fixture = await seedAmbroseFixture({
      db,
      baseUrl,
      suffix: 'conflict',
      year: 2030
    });
    const { scorecardId, philCookie, benCookie } = fixture;

    const a1 = await fetch(`${baseUrl}/scoring/api/live/gross`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: philCookie },
      body: JSON.stringify({ scorecardId, holeNumber: 1, grossScore: 5 })
    });
    assert.equal(a1.status, 200);
    const a1Body = await a1.json();
    assert.equal(a1Body.ok, true);
    assert.equal(a1Body.grossScore, 5);

    const bConflict = await fetch(`${baseUrl}/scoring/api/live/gross`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: benCookie },
      body: JSON.stringify({ scorecardId, holeNumber: 1, grossScore: 4 })
    });
    assert.equal(bConflict.status, 409);
    const bConflictBody = await bConflict.json();
    assert.equal(bConflictBody.error, 'conflict');
    assert.equal(bConflictBody.canonicalGross, 5);
    assert.equal(bConflictBody.ownerName, 'Phil K.');

    const a2 = await fetch(`${baseUrl}/scoring/api/live/gross`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: philCookie },
      body: JSON.stringify({ scorecardId, holeNumber: 1, grossScore: 4 })
    });
    assert.equal(a2.status, 200);

    const b2 = await fetch(`${baseUrl}/scoring/api/live/gross`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: benCookie },
      body: JSON.stringify({ scorecardId, holeNumber: 1, grossScore: 4 })
    });
    assert.equal(b2.status, 200);
    const b2Body = await b2.json();
    assert.equal(b2Body.ok, true);
    assert.equal(b2Body.grossScore, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.destroy();
  }
});

test('ambrose pre-navigation hole refresh exposes changed canonical score', async () => {
  const db = await createDb();
  const app = createApp({ db, sessionStore: new session.MemoryStore() });
  const server = app.listen(0);

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const fixture = await seedAmbroseFixture({
      db,
      baseUrl,
      suffix: 'prenav',
      year: 2031
    });
    const { scorecardId, philCookie, benCookie } = fixture;

    const a1 = await fetch(`${baseUrl}/scoring/api/live/gross`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: philCookie },
      body: JSON.stringify({ scorecardId, holeNumber: 1, grossScore: 4 })
    });
    assert.equal(a1.status, 200);

    const b1 = await fetch(`${baseUrl}/scoring/api/live/gross`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: benCookie },
      body: JSON.stringify({ scorecardId, holeNumber: 1, grossScore: 4 })
    });
    assert.equal(b1.status, 200);

    const a2 = await fetch(`${baseUrl}/scoring/api/live/gross`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: philCookie },
      body: JSON.stringify({ scorecardId, holeNumber: 1, grossScore: 5 })
    });
    assert.equal(a2.status, 200);

    // This mirrors the client "pre-nav" refresh call.
    const preNav = await fetch(`${baseUrl}/scoring/api/live/${scorecardId}/hole/1`, {
      headers: { cookie: benCookie }
    });
    assert.equal(preNav.status, 200);
    const preNavBody = await preNav.json();
    const teamEntry = (preNavBody.entries || []).find((e) => Number(e.scorecardId) === Number(scorecardId));
    assert.ok(teamEntry);
    assert.equal(Number(teamEntry.grossScore), 5);

    // If B now retries old local value, API reports a conflict.
    const bConflict = await fetch(`${baseUrl}/scoring/api/live/gross`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: benCookie },
      body: JSON.stringify({ scorecardId, holeNumber: 1, grossScore: 4 })
    });
    assert.equal(bConflict.status, 409);
    const bConflictBody = await bConflict.json();
    assert.equal(bConflictBody.error, 'conflict');
    assert.equal(bConflictBody.canonicalGross, 5);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.destroy();
  }
});

test('ambrose confirmation displays fractional handicap and fractional net total', async () => {
  const db = await createDb();
  const app = createApp({ db, sessionStore: new session.MemoryStore() });
  const server = app.listen(0);

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const fixture = await seedAmbroseFixture({
      db,
      baseUrl,
      suffix: 'confirmfraction',
      year: 2032
    });
    const { scorecardId, philCookie } = fixture;

    // Force a 2-man team handicap of 5 1/4: (10 + 11) * 1/4
    const scorecard = await db('scorecards').where({ id: scorecardId }).first();
    const members = await db('team_members').where({ team_id: scorecard.team_id }).orderBy('id', 'asc');
    await db('player_handicaps')
      .where({ event_id: scorecard.event_id, user_id: members[0].user_id })
      .update({ playing_handicap: 10 });
    await db('player_handicaps')
      .where({ event_id: scorecard.event_id, user_id: members[1].user_id })
      .update({ playing_handicap: 11 });

    // Gross total 72 gives net 66 3/4 with handicap 5 1/4.
    const holeRows = [];
    for (let hole = 1; hole <= 18; hole += 1) {
      holeRows.push({
        scorecard_id: scorecardId,
        hole_number: hole,
        gross_score: 4,
        stableford_points: 2,
        owner_user_id: members[0].user_id
      });
    }
    await db('scorecard_holes').insert(holeRows);

    const res = await fetch(`${baseUrl}/scoring/confirm/${scorecardId}`, {
      headers: { cookie: philCookie }
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('Hcp 5 1/4'));
    assert.ok(html.includes('Net <strong>66 3/4</strong>'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.destroy();
  }
});
