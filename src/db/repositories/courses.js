'use strict';

const { TEST_TENANT_ID } = require('../../config/constants');

async function findById(db, id) {
  return db('courses').where({ id }).first();
}

async function findByTenant(db, tenantId) {
  const q = db('courses').orderBy('course_name');
  if (tenantId !== TEST_TENANT_ID) q.where({ tenant_id: tenantId });
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
