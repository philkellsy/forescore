'use strict';

async function findByTour(db, tourId) {
  return db('itinerary_items').where({ tour_id: tourId }).orderBy(['item_date', 'sort_order', 'start_time']);
}

async function findByDate(db, tourId, itemDate) {
  return db('itinerary_items').where({ tour_id: tourId, item_date: itemDate }).orderBy(['sort_order', 'start_time']);
}

async function findById(db, id) {
  return db('itinerary_items').where({ id }).first();
}

async function create(db, data) {
  const [row] = await db('itinerary_items').insert(data).returning('*');
  return row;
}

async function update(db, id, data) {
  const [row] = await db('itinerary_items').where({ id }).update(data).returning('*');
  return row;
}

async function remove(db, id) {
  await db('itinerary_items').where({ id }).delete();
}

module.exports = { findByTour, findByDate, findById, create, update, remove };
