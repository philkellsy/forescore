'use strict';

async function findById(db, id) {
  return db('tours').where({ id }).first();
}

async function findByTenant(db, tenantId) {
  return db('tours').where({ tenant_id: tenantId }).orderBy('year', 'desc');
}

async function findActive(db, tenantId) {
  return db('tours').where({ tenant_id: tenantId, status: 'active' }).first();
}

async function findAllWithTenants(db) {
  return db('tours as t')
    .join('tenants as tn', 'tn.id', 't.tenant_id')
    .select(
      't.id',
      't.label',
      't.year',
      't.status',
      't.is_paid',
      't.paid_at',
      'tn.id as tenant_id',
      'tn.name as tenant_name',
      'tn.slug as tenant_slug',
    )
    .orderBy(['tn.name', 't.year']);
}

async function create(db, data) {
  const [row] = await db('tours').insert(data).returning('*');
  return row;
}

async function update(db, id, data) {
  const [row] = await db('tours').where({ id }).update(data).returning('*');
  return row;
}

async function markDirty(db, id) {
  await db('tours').where({ id }).update({ leaderboard_dirty_at: db.fn.now() });
}

module.exports = { findById, findByTenant, findActive, findAllWithTenants, create, update, markDirty };
