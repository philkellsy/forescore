'use strict';

async function findById(db, id) {
  return db('events').where({ id }).first();
}

async function findByTenant(db, tenantId) {
  return db('events').where({ tenant_id: tenantId }).orderBy('year', 'desc');
}

async function findActive(db, tenantId) {
  return db('events').where({ tenant_id: tenantId, status: 'active' }).first();
}

async function findAllWithTenants(db) {
  return db('events as e')
    .join('tenants as t', 't.id', 'e.tenant_id')
    .select(
      'e.id',
      'e.label',
      'e.year',
      'e.status',
      'e.is_paid',
      'e.paid_at',
      'e.start_date',
      'e.end_date',
      't.id as tenant_id',
      't.name as tenant_name',
      't.slug as tenant_slug',
    )
    .orderBy(['t.name', 'e.year']);
}

async function create(db, data) {
  const [row] = await db('events').insert(data).returning('*');
  return row;
}

async function update(db, id, data) {
  const [row] = await db('events').where({ id }).update(data).returning('*');
  return row;
}

async function markDirty(db, id) {
  await db('events').where({ id }).update({ leaderboard_dirty_at: db.fn.now() });
}

module.exports = { findById, findByTenant, findActive, findAllWithTenants, create, update, markDirty };
