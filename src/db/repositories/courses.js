'use strict';

async function findById(db, id) {
  return db('courses').where({ id }).first();
}

async function findByTenant(db, tenantId) {
  return db('courses').where({ tenant_id: tenantId }).orderBy('course_name');
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
