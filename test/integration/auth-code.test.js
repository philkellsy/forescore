'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');

const { createTestDb, seedTenantAndOwner } = require('../helpers/pg');
const { createApp } = require('../../src/app');
const { createLoginCode } = require('../../src/services/auth/login-code.service');

const TENANT_SLUG = 'auth-test-tenant';

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

test('auth verify-code accepts mobile lookup and consumes code once', async () => {
  const { db, server, baseUrl } = await setup();
  const ts = Date.now();
  const slug = `auth-mobile-${ts}`;

  try {
    const [tenant] = await db('tenants').insert({
      name: 'Auth Test', slug, plan: 'free', subscription_status: 'active', settings: '{}',
    }).returning('*');

    const [user] = await db('users').insert({
      first_name: 'Mobile', last_name: 'User',
      email: `mobile.${ts}@test.local`,
      phone_number: `040012${String(ts).slice(-4)}`,
      email_verified_at: db.fn.now(),
    }).returning('*');

    await db('tenant_memberships').insert({ tenant_id: tenant.id, user_id: user.id, role: 'player' });

    const { code } = await createLoginCode(db, user.id, '127.0.0.1', 'integration-test');
    const body = new URLSearchParams({ lookup: user.phone_number, code });

    const verifyRes = await fetch(`${baseUrl}/${slug}/auth/verify-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    });

    assert.equal(verifyRes.status, 302);
    assert.match(String(verifyRes.headers.get('set-cookie') || ''), /connect\.sid=/i);
    assert.match(String(verifyRes.headers.get('location') || ''), new RegExp(`/${slug}/`));

    // Second attempt must fail — code is consumed
    const secondRes = await fetch(`${baseUrl}/${slug}/auth/verify-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    });
    assert.equal(secondRes.status, 400);
    const html = await secondRes.text();
    assert.match(html, /Invalid or expired code/i);
  } finally {
    await teardown(server, db);
  }
});

test('auth verify-code rejects user with no membership in the requested tenant', async () => {
  const { db, server, baseUrl } = await setup();
  const ts = Date.now();
  const slug = `auth-noaccess-${ts}`;

  try {
    await db('tenants').insert({
      name: 'No Access Tenant', slug, plan: 'free', subscription_status: 'active', settings: '{}',
    });

    // User exists globally but has no membership in this tenant
    const [user] = await db('users').insert({
      first_name: 'Stranger', last_name: 'User',
      email: `stranger.${ts}@test.local`,
      email_verified_at: db.fn.now(),
    }).returning('*');

    const { code } = await createLoginCode(db, user.id, '127.0.0.1', 'integration-test');
    const body = new URLSearchParams({ lookup: user.email, code });

    const res = await fetch(`${baseUrl}/${slug}/auth/verify-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    });

    assert.equal(res.status, 403);
    const html = await res.text();
    assert.match(html, /Contact your tour administrator/i);
  } finally {
    await teardown(server, db);
  }
});

test('unknown tenant slug returns 404', async () => {
  const { db, server, baseUrl } = await setup();
  try {
    const res = await fetch(`${baseUrl}/does-not-exist/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 404);
  } finally {
    await teardown(server, db);
  }
});
