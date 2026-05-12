'use strict';

const knex = require('knex');
const { bootstrap } = require('../../src/bootstrap');
const { createLoginCode } = require('../../src/services/auth/login-code.service');

async function createTestDb() {
  const db = knex({
    client: 'pg',
    connection: process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/forescore_test',
  });
  await bootstrap(db);
  return db;
}

// Creates a tenant + an owner user, returns their full DB rows
async function seedTenantAndOwner(db, overrides = {}) {
  const ts = Date.now();
  const [tenant] = await db('tenants').insert({
    name: overrides.tenantName || 'Test Tenant',
    slug: overrides.slug || `test-${ts}`,
    plan: 'free',
    subscription_status: 'active',
    settings: '{}',
  }).returning('*');

  const [owner] = await db('users').insert({
    first_name: overrides.firstName || 'Test',
    last_name: overrides.lastName || 'Owner',
    email: overrides.email || `owner-${ts}@test.local`,
    email_verified_at: db.fn.now(),
  }).returning('*');

  await db('tenant_memberships').insert({
    tenant_id: tenant.id,
    user_id: owner.id,
    role: 'owner',
  });

  return { tenant, owner };
}

// Creates a minimal tour scoped to a tenant
async function seedEvent(db, tenantId, overrides = {}) {
  const ts = Date.now();
  const [tour] = await db('tours').insert({
    tenant_id: tenantId,
    label: overrides.label || `Test Tour ${ts}`,
    year: overrides.year || 2030,
    location: overrides.location || 'Test Location',
    status: overrides.status || 'draft',
    is_paid: overrides.is_paid ?? false,
    paid_at: overrides.paid_at || null,
  }).returning('*');
  return tour;
}

// Seeds a complete scoring scenario: course + 18 holes, active tour, open round,
// tee group with the given user, individual scorecard. Returns all created rows.
async function seedScoringScenario(db, tenantId, userId) {
  const ts = Date.now();

  const [course] = await db('courses').insert({
    tenant_id: tenantId,
    course_name: `Test Course ${ts}`,
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
    label: `Test Tour ${ts}`,
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
    calc_type: 'stableford',
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

  const [scorecard] = await db('scorecards').insert({
    tour_id: tour.id,
    round_number: 1,
    type: 'individual',
    user_id: userId,
    status: 'draft',
  }).returning('*');

  return { course, tour, round, teeGroup, scorecard };
}

// Returns a session cookie for the given user authenticated against a tenant slug.
async function getSessionCookie(baseUrl, slug, db, user) {
  const { code } = await createLoginCode(db, user.id, '127.0.0.1', 'test');
  const body = new URLSearchParams({ lookup: user.email, code });
  const res = await fetch(`${baseUrl}/${slug}/auth/verify-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  });
  return res.headers.get('set-cookie');
}

module.exports = { createTestDb, seedTenantAndOwner, seedEvent, seedScoringScenario, getSessionCookie };
