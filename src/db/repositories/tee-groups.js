'use strict';

// Returns tee groups with their player list joined
async function findByEventDay(db, tourId, roundNumber) {
  const groups = await db('tee_groups')
    .where({ tour_id: tourId, round_number: roundNumber })
    .orderBy('group_number');

  if (groups.length === 0) return groups;

  const groupIds = groups.map((g) => g.id);
  const players = await db('tee_group_players as tgp')
    .join('users as u', 'u.id', 'tgp.user_id')
    .whereIn('tgp.tee_group_id', groupIds)
    .orderBy('tgp.position')
    .select('tgp.*', 'u.first_name', 'u.last_name');

  const playersByGroup = {};
  for (const p of players) {
    (playersByGroup[p.tee_group_id] ||= []).push(p);
  }

  return groups.map((g) => ({ ...g, players: playersByGroup[g.id] || [] }));
}

async function create(db, data) {
  const [row] = await db('tee_groups').insert(data).returning('*');
  return row;
}

async function addPlayer(db, teeGroupId, userId, position) {
  const [row] = await db('tee_group_players')
    .insert({ tee_group_id: teeGroupId, user_id: userId, position })
    .returning('*');
  return row;
}

async function removePlayer(db, teeGroupId, userId) {
  await db('tee_group_players').where({ tee_group_id: teeGroupId, user_id: userId }).delete();
}

async function clearDay(db, tourId, roundNumber) {
  const ids = await db('tee_groups').where({ tour_id: tourId, round_number: roundNumber }).pluck('id');
  if (ids.length > 0) {
    await db('tee_group_players').whereIn('tee_group_id', ids).delete();
  }
  await db('tee_groups').where({ tour_id: tourId, round_number: roundNumber }).delete();
}

module.exports = { findByEventDay, create, addPlayer, removePlayer, clearDay };
