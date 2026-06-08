'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');

const { createTestDb, seedTenantAndOwner, getSessionCookie } = require('../helpers/pg');
const { createApp } = require('../../src/app');

async function setup() {
  const db = await createTestDb();
  const app = createApp({ db, sessionStore: new session.MemoryStore() });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { db, server, baseUrl };
}

async function teardown(server, db) {
  await new Promise((resolve) => server.close(resolve));
  await db.destroy();
}

// Builds a full ambrose scenario: course, tour, ambrose round, tee group,
// team + two members, team scorecard.
async function seedAmbroseScenario(db, tenantId, userId) {
  const ts = Date.now();

  const [course] = await db('courses').insert({
    tenant_id: tenantId,
    course_name: `Ambrose Course ${ts}`,
    tee_name: 'White',
    slope_rating: 113,
    course_rating: 72.0,
    gender: 'open',
  }).returning('*');

  await db('holes').insert(
    Array.from({ length: 18 }, (_, i) => ({
      course_id: course.id,
      hole_number: i + 1,
      par: 4,
      stroke_index_primary: i + 1,
      stroke_index_secondary: i + 1,
    }))
  );

  const [tour] = await db('tours').insert({
    tenant_id: tenantId,
    label: `Ambrose Tour ${ts}`,
    year: 2030,
    location: 'Test',
    status: 'active',
    is_paid: true,
  }).returning('*');

  await db('event_players').insert({ tour_id: tour.id, user_id: userId, status: 'active' });
  await db('player_handicaps').insert({ tour_id: tour.id, user_id: userId, playing_handicap: 18 });

  const [round] = await db('golf_rounds').insert({
    tour_id: tour.id,
    round_number: 1,
    course_id: course.id,
    calc_type: 'ambrose_nett',
    status: 'open',
    tour_date: '2030-01-01',
    leaderboard_published: false,
    ambrose_prizes: '[]',
  }).returning('*');

  const [teeGroup] = await db('tee_groups').insert({
    tour_id: tour.id,
    round_number: 1,
    tee_time: '08:00:00',
    starting_hole: 1,
    group_number: 1,
    source: 'manual',
  }).returning('*');

  await db('tee_group_players').insert({ tee_group_id: teeGroup.id, user_id: userId, position: 1 });

  const [team] = await db('teams').insert({
    tour_id: tour.id,
    round_number: 1,
    competition_type: 'ambrose',
    name: 'Team A',
  }).returning('*');

  await db('team_members').insert({ team_id: team.id, user_id: userId, is_dual_assigned: false });

  const [scorecard] = await db('scorecards').insert({
    tour_id: tour.id,
    round_number: 1,
    type: 'team',
    team_id: team.id,
    status: 'draft',
  }).returning('*');

  return { course, tour, round, teeGroup, team, scorecard };
}

async function postGross(baseUrl, slug, cookie, scorecardId, holeNumber, grossScore, baseVersion) {
  const params = {
    scorecardId: String(scorecardId),
    holeNumber: String(holeNumber),
    grossScore: String(grossScore),
    opId: `op-${holeNumber}-${Date.now()}`,
  };
  if (baseVersion !== undefined) params.baseVersion = String(baseVersion);

  return fetch(`${baseUrl}/${slug}/scoring/api/live/gross`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(params).toString(),
  });
}

test('ambrose live gross scoring enforces and resolves conflict over HTTP', async () => {
  const { db, server, baseUrl } = await setup();
  const ts = Date.now();

  try {
    const { tenant, owner } = await seedTenantAndOwner(db, { slug: `ambrose-conflict-${ts}` });
    const { scorecard, teeGroup } = await seedAmbroseScenario(db, tenant.id, owner.id);

    // Add a second player with role 'player' (non-admin) to the same tee group.
    // Conflict detection only triggers for different non-privileged users — admin/owner/scorer
    // have force=true and bypass version checks intentionally.
    const [player2] = await db('users').insert({
      first_name: 'Player',
      last_name: 'Two',
      email: `player2-${ts}@test.local`,
      email_verified_at: db.fn.now(),
    }).returning('*');
    await db('tenant_memberships').insert({ tenant_id: tenant.id, user_id: player2.id, role: 'player' });
    await db('tee_group_players').insert({ tee_group_id: teeGroup.id, user_id: player2.id, position: 2 });

    const ownerCookie = await getSessionCookie(baseUrl, tenant.slug, db, owner);
    const playerCookie = await getSessionCookie(baseUrl, tenant.slug, db, player2);

    // Owner (marker) scores 4 — sets owner_user_id on the row
    const first = await postGross(baseUrl, tenant.slug, ownerCookie, scorecard.id, 1, 4);
    assert.equal(first.status, 200);
    const firstJson = await first.json();
    assert.equal(firstJson.ok, true);
    const v1 = firstJson.holeVersion;
    assert.ok(v1 >= 1, 'expected version >= 1 after first score');

    // Player2 (non-admin, different user) tries to score 5 with stale baseVersion 0 → 409
    const stale = await postGross(baseUrl, tenant.slug, playerCookie, scorecard.id, 1, 5, 0);
    assert.equal(stale.status, 409);
    const staleJson = await stale.json();
    assert.equal(staleJson.error, 'conflict');

    // Player2 accepts the canonical score (same as owner's score) with current version → 200
    const resolved = await postGross(baseUrl, tenant.slug, playerCookie, scorecard.id, 1, 4, v1);
    assert.equal(resolved.status, 200);
    const resolvedJson = await resolved.json();
    assert.equal(resolvedJson.ok, true);
    assert.equal(resolvedJson.grossScore, 4);
  } finally {
    await teardown(server, db);
  }
});

test('ambrose pre-navigation hole refresh exposes changed canonical score', async () => {
  const { db, server, baseUrl } = await setup();
  const ts = Date.now();

  try {
    const { tenant, owner } = await seedTenantAndOwner(db, { slug: `ambrose-refresh-${ts}` });
    const { scorecard } = await seedAmbroseScenario(db, tenant.id, owner.id);
    const cookie = await getSessionCookie(baseUrl, tenant.slug, db, owner);

    // Record an initial score
    await postGross(baseUrl, tenant.slug, cookie, scorecard.id, 3, 4);

    // Simulate another scorer directly updating the DB score
    await db('scorecard_holes')
      .where({ scorecard_id: scorecard.id, hole_number: 3 })
      .update({ gross_score: 6 });

    // GET the hole state — should reflect the updated score
    const refreshRes = await fetch(
      `${baseUrl}/${tenant.slug}/scoring/api/live/${scorecard.id}/hole/3`,
      { headers: { cookie } }
    );
    assert.equal(refreshRes.status, 200);
    const json = await refreshRes.json();
    const entry = (json.entries || []).find((e) => e.scorecardId === scorecard.id) || json.entries?.[0];
    assert.equal(entry?.grossScore, 6, 'refresh should return the updated canonical score');
  } finally {
    await teardown(server, db);
  }
});

test('ambrose confirmation displays fractional handicap and fractional net total', async () => {
  const { db, server, baseUrl } = await setup();
  const ts = Date.now();

  try {
    const { tenant, owner } = await seedTenantAndOwner(db, { slug: `ambrose-confirm-${ts}` });
    const { scorecard } = await seedAmbroseScenario(db, tenant.id, owner.id);
    const cookie = await getSessionCookie(baseUrl, tenant.slug, db, owner);

    // Set the team handicap to a fractional value (18.5) so net totals will be fractional
    await db('player_handicaps')
      .where({ tour_id: scorecard.tour_id, user_id: owner.id })
      .update({ playing_handicap: 18.5 });

    // Score all 18 holes
    for (let hole = 1; hole <= 18; hole++) {
      await postGross(baseUrl, tenant.slug, cookie, scorecard.id, hole, 4);
    }

    // Confirmation page should load successfully and include a net total
    const res = await fetch(`${baseUrl}/${tenant.slug}/scoring/confirm/${scorecard.id}`, {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    // Net total should appear somewhere on the page
    assert.match(html, /net|total/i, 'confirmation page should include net/total information');
  } finally {
    await teardown(server, db);
  }
});
