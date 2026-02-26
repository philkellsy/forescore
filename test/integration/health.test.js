'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');

const { createApp } = require('../../src/app');

function createDummyDb() {
  const fail = () => {
    throw new Error('Dummy db accessed in this test');
  };

  const qb = () => ({
    where: () => ({ first: async () => null })
  });

  qb.schema = {};
  qb.fn = { now: () => new Date() };
  qb.raw = fail;
  return qb;
}

test('GET /health returns ok', async () => {
  const app = createApp({ db: createDummyDb(), sessionStore: new session.MemoryStore() });
  const server = app.listen(0);

  try {
    const address = server.address();
    const res = await fetch(`http://127.0.0.1:${address.port}/health`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
