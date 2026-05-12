'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, seedTenantAndOwner, seedEvent } = require('../helpers/pg');

let db;
let tenant;

before(async () => {
  db = await createTestDb();
  ({ tenant } = await seedTenantAndOwner(db, { slug: `status-db-${Date.now()}` }));
});

after(async () => {
  await db.destroy();
});

describe('tours table — status schema', () => {
  it('new tour defaults to status=draft and is_paid=false', async () => {
    const tour = await seedEvent(db, tenant.id);
    assert.equal(tour.status, 'draft');
    assert.equal(tour.is_paid, false);
    assert.equal(tour.paid_at, null);
  });

  it('tour can be marked paid and status set to active', async () => {
    const tour = await seedEvent(db, tenant.id);
    await db('tours').where({ id: tour.id }).update({ is_paid: true, paid_at: db.fn.now(), status: 'active' });
    const updated = await db('tours').where({ id: tour.id }).first();
    assert.equal(updated.is_paid, true);
    assert.ok(updated.paid_at !== null);
    assert.equal(updated.status, 'active');
  });

  it('tour can be transitioned to completed', async () => {
    const tour = await seedEvent(db, tenant.id, { status: 'active', is_paid: true });
    await db('tours').where({ id: tour.id }).update({ status: 'completed' });
    const updated = await db('tours').where({ id: tour.id }).first();
    assert.equal(updated.status, 'completed');
  });

  it('check constraint rejects invalid status value', async () => {
    const tour = await seedEvent(db, tenant.id);
    await assert.rejects(
      db('tours').where({ id: tour.id }).update({ status: 'bogus' }),
    );
  });
});
