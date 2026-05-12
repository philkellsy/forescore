'use strict';

async function findByTenantAndUser(db, tenantId, userId) {
  return db('tenant_memberships').where({ tenant_id: tenantId, user_id: userId }).first();
}

// Returns all tenants a user belongs to, with tenant data joined
async function findAllByUser(db, userId) {
  return db('tenant_memberships as m')
    .join('tenants as t', 't.id', 'm.tenant_id')
    .where('m.user_id', userId)
    .select('m.*', 't.name as tenant_name', 't.slug as tenant_slug');
}

// Returns all members of a tenant, with user data joined
async function findAllByTenant(db, tenantId) {
  return db('tenant_memberships as m')
    .join('users as u', 'u.id', 'm.user_id')
    .where('m.tenant_id', tenantId)
    .select(
      'm.*',
      'u.first_name',
      'u.last_name',
      'u.email',
      'u.phone_number',
    );
}

async function create(db, data) {
  const [row] = await db('tenant_memberships').insert(data).returning('*');
  return row;
}

async function updateRole(db, id, role) {
  const [row] = await db('tenant_memberships').where({ id }).update({ role }).returning('*');
  return row;
}

async function remove(db, tenantId, userId) {
  await db('tenant_memberships').where({ tenant_id: tenantId, user_id: userId }).delete();
}

module.exports = {
  findByTenantAndUser,
  findAllByUser,
  findAllByTenant,
  create,
  updateRole,
  remove,
};
