'use strict';

async function findById(db, id) {
  return db('courses').where({ id }).first();
}

async function findByTenant(db, tenant) {
  const q = db('courses').orderBy('course_name');
  if (!tenant?.is_test_tenant) q.where({ tenant_id: tenant?.id });
  return q;
}

async function create(db, data) {
  const [row] = await db('courses').insert(data).returning('*');
  return row;
}

async function update(db, id, data) {
  const [row] = await db('courses').where({ id }).update(data).returning('*');
  return row;
}

async function remove(db, id) {
  await db('courses').where({ id }).delete();
}

module.exports = { findById, findByTenant, create, update, remove };
