'use strict';

async function findById(db, id) {
  return db('scorecards').where({ id }).first();
}

async function findByEventDay(db, tourId, roundNumber) {
  return db('scorecards').where({ tour_id: tourId, round_number: roundNumber });
}

async function findForUser(db, tourId, roundNumber, userId) {
  return db('scorecards')
    .where({ tour_id: tourId, round_number: roundNumber, type: 'individual', user_id: userId })
    .first();
}

async function findForTeam(db, tourId, roundNumber, teamId) {
  return db('scorecards')
    .where({ tour_id: tourId, round_number: roundNumber, type: 'team', team_id: teamId })
    .first();
}

async function create(db, data) {
  const [row] = await db('scorecards').insert(data).returning('*');
  return row;
}

async function updateStatus(db, id, status) {
  const [row] = await db('scorecards').where({ id }).update({ status }).returning('*');
  return row;
}

module.exports = {
  findById,
  findByEventDay,
  findForUser,
  findForTeam,
  create,
  updateStatus,
};
