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

test('auth verify-code accepts mobile lookup and consumes code once', async () => {
  const db = await createDb();
  const app = createApp({ db, sessionStore: new session.MemoryStore() });
  const server = app.listen(0);

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const [userId] = await db('users').insert({
      first_name: 'Mobile',
      last_name: 'User',
      email: 'mobile.user@test.local',
      phone_number: '0400123456',
      role: ROLES.PLAYER
    });

    const { code } = await createLoginCode(db, Number(userId), '127.0.0.1', 'integration-test');
    const verifyBody = new URLSearchParams({
      lookup: '0400 123 456',
      code
    });
    const verifyRes = await fetch(`${baseUrl}/auth/verify-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: verifyBody.toString(),
      redirect: 'manual'
    });

    assert.equal(verifyRes.status, 302);
    assert.match(String(verifyRes.headers.get('set-cookie') || ''), /connect\.sid=/i);

    const secondTryRes = await fetch(`${baseUrl}/auth/verify-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: verifyBody.toString(),
      redirect: 'manual'
    });
    assert.equal(secondTryRes.status, 400);
    const secondTryHtml = await secondTryRes.text();
    assert.match(secondTryHtml, /Invalid or expired code/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.destroy();
  }
});

