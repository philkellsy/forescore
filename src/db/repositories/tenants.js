'use strict';

async function findBySlug(db, slug) {
  return db('tenants').where({ slug }).first();
}

async function findById(db, id) {
  return db('tenants').where({ id }).first();
}

async function create(db, data) {
  const [row] = await db('tenants').insert(data).returning('*');
  return row;
}

async function update(db, id, data) {
  const [row] = await db('tenants').where({ id }).update(data).returning('*');
  return row;
}

module.exports = { findBySlug, findById, create, update };
