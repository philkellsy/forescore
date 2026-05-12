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

test('player dashboard shows open scorecard chip and published prize winnings', async () => {
  const { db, server, baseUrl } = await setup();
  const ts = Date.now();

  try {
    const { tenant, owner } = await seedTenantAndOwner(db, { slug: `prizes-dash-${ts}` });
    const { scorecard, tour } = await seedScoringScenario(db, tenant.id, owner.id);
    const cookie = await getSessionCookie(baseUrl, tenant.slug, db, owner);

    // Configure daily prizes and publish the leaderboard
    await db('tours').where({ id: tour.id }).update({
      daily_prizes: JSON.stringify([{ label: '1st Place', amount: 150 }]),
    });
    await db('golf_rounds')
      .where({ tour_id: tour.id, round_number: 1 })
      .update({ leaderboard_published: true });

    const res = await fetch(`${baseUrl}/${tenant.slug}/`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();

    // Dashboard should include a link to the player's open scorecard
    assert.match(html, new RegExp(`/scoring/live/${scorecard.id}`), 'expected scorecard link on dashboard');
  } finally {
    await teardown(server, db);
  }
});

test('leaderboard page includes configured daily prize labels and amounts', async () => {
  const { db, server, baseUrl } = await setup();
  const ts = Date.now();

  try {
    const { tenant, owner } = await seedTenantAndOwner(db, { slug: `prizes-lb-${ts}` });
    const { tour } = await seedScoringScenario(db, tenant.id, owner.id);
    const cookie = await getSessionCookie(baseUrl, tenant.slug, db, owner);

    await db('tours').where({ id: tour.id }).update({
      daily_prizes: JSON.stringify([
        { label: 'Daily Winner', amount: 100 },
        { label: 'Runner Up', amount: 50 },
      ]),
    });
    await db('golf_rounds')
      .where({ tour_id: tour.id, round_number: 1 })
      .update({ leaderboard_published: true });

    const res = await fetch(`${baseUrl}/${tenant.slug}/leaderboards`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /Daily Winner/, 'expected daily prize label on leaderboard');
    assert.match(html, /\$100/, 'expected daily prize amount on leaderboard');
  } finally {
    await teardown(server, db);
  }
});

test('tour setup saves daily prizes and they are reflected in the tour record', async () => {
  const { db, server, baseUrl } = await setup();
  const ts = Date.now();

  try {
    const { tenant, owner } = await seedTenantAndOwner(db, { slug: `prizes-setup-${ts}` });
    const { tour } = await seedScoringScenario(db, tenant.id, owner.id);
    const cookie = await getSessionCookie(baseUrl, tenant.slug, db, owner);

    const body = new URLSearchParams([
      ['daily_prize_label', '1st Place'],
      ['daily_prize_amount', '200'],
      ['daily_prize_label', '2nd Place'],
      ['daily_prize_amount', '100'],
    ]);

    const res = await fetch(`${baseUrl}/${tenant.slug}/admin/tours/${tour.id}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: body.toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);

    const updated = await db('tours').where({ id: tour.id }).first();
    const prizes = Array.isArray(updated.daily_prizes)
      ? updated.daily_prizes
      : JSON.parse(updated.daily_prizes);
    assert.equal(prizes.length, 2);
    assert.equal(prizes[0].label, '1st Place');
    assert.equal(prizes[0].amount, 200);
    assert.equal(prizes[1].label, '2nd Place');
    assert.equal(prizes[1].amount, 100);
  } finally {
    await teardown(server, db);
  }
});
