'use strict';

async function findById(db, id) {
  return db('users').where({ id }).first();
}

async function findByEmail(db, email) {
  return db('users').where({ email }).first();
}

async function findByPhone(db, phone) {
  return db('users').where({ phone_number: phone }).first();
}

// Used during auth: accepts either email or phone_number as lookup value
async function findByEmailOrPhone(db, lookup) {
  return db('users')
    .where({ email: lookup })
    .orWhere({ phone_number: lookup })
    .first();
}

async function create(db, data) {
  const [row] = await db('users').insert(data).returning('*');
  return row;
}

async function update(db, id, data) {
  const [row] = await db('users').where({ id }).update(data).returning('*');
  return row;
}

module.exports = { findById, findByEmail, findByPhone, findByEmailOrPhone, create, update };
