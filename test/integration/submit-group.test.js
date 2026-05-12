'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');

const { createTestDb, seedTenantAndOwner, seedScoringScenario, getSessionCookie } = require('../helpers/pg');
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

async function postGrossScore(baseUrl, slug, cookie, scorecardId, holeNumber, grossScore) {
  return fetch(`${baseUrl}/${slug}/scoring/api/live/gross`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      scorecardId: String(scorecardId),
      holeNumber: String(holeNumber),
      grossScore: String(grossScore),
      opId: `op-${holeNumber}-${Date.now()}`,
    }).toString(),
  });
}

test('confirm submit finalizes all scorecards in the individual group', async () => {
  const { db, server, baseUrl } = await setup();
  const ts = Date.now();

  try {
    const { tenant, owner } = await seedTenantAndOwner(db, { slug: `submit-${ts}` });
    const { scorecard } = await seedScoringScenario(db, tenant.id, owner.id);
    const cookie = await getSessionCookie(baseUrl, tenant.slug, db, owner);

    // Score all 18 holes
    for (let hole = 1; hole <= 18; hole++) {
      const res = await postGrossScore(baseUrl, tenant.slug, cookie, scorecard.id, hole, 4);
      assert.equal(res.status, 200, `hole ${hole} POST failed`);
      const json = await res.json();
      assert.equal(json.ok, true, `hole ${hole} response not ok`);
    }

    // Get confirm-final page to capture the snapshot
    const confirmRes = await fetch(`${baseUrl}/${tenant.slug}/scoring/confirm/${scorecard.id}/final`, {
      headers: { cookie },
    });
    assert.equal(confirmRes.status, 200);
    const html = await confirmRes.text();

    const match = html.match(/name="submitSnapshot"\s+value="([a-f0-9]+)"/);
    assert.ok(match, 'submitSnapshot hidden field not found in confirm-final page');
    const submitSnapshot = match[1];

    // Submit
    const submitRes = await fetch(`${baseUrl}/${tenant.slug}/scoring/confirm/${scorecard.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ submitSnapshot }).toString(),
    });
    assert.equal(submitRes.status, 200);
    const result = await submitRes.json();
    assert.equal(result.ok, true);

    const updated = await db('scorecards').where({ id: scorecard.id }).first();
    assert.equal(updated.status, 'submitted');
  } finally {
    await teardown(server, db);
  }
});

test('confirm submit rejects when group scores changed after confirmation snapshot', async () => {
  const { db, server, baseUrl } = await setup();
  const ts = Date.now();

  try {
    const { tenant, owner } = await seedTenantAndOwner(db, { slug: `stale-${ts}` });
    const { scorecard } = await seedScoringScenario(db, tenant.id, owner.id);
    const cookie = await getSessionCookie(baseUrl, tenant.slug, db, owner);

    // Score all 18 holes
    for (let hole = 1; hole <= 18; hole++) {
      await postGrossScore(baseUrl, tenant.slug, cookie, scorecard.id, hole, 4);
    }

    // Capture the snapshot
    const confirmRes = await fetch(`${baseUrl}/${tenant.slug}/scoring/confirm/${scorecard.id}/final`, {
      headers: { cookie },
    });
    const html = await confirmRes.text();
    const match = html.match(/name="submitSnapshot"\s+value="([a-f0-9]+)"/);
    const capturedSnapshot = match[1];

    // Simulate a scorer changing hole 1 after the snapshot was captured
    await db('scorecard_holes')
      .where({ scorecard_id: scorecard.id, hole_number: 1 })
      .update({ gross_score: 7, updated_at: db.fn.now() });

    // Submit with the stale snapshot — should be rejected
    const submitRes = await fetch(`${baseUrl}/${tenant.slug}/scoring/confirm/${scorecard.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ submitSnapshot: capturedSnapshot }).toString(),
    });
    assert.equal(submitRes.status, 409);
    const body = await submitRes.json();
    assert.equal(body.error, 'stale_scores');

    const sc = await db('scorecards').where({ id: scorecard.id }).first();
    assert.equal(sc.status, 'draft', 'scorecard should remain draft after stale rejection');
  } finally {
    await teardown(server, db);
  }
});
