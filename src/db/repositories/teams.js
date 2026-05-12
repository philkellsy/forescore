'use strict';

// Returns teams with their member list joined
async function findByEventDay(db, tourId, roundNumber) {
  const teams = await db('teams').where({ tour_id: tourId, round_number: roundNumber }).orderBy('name');

  if (teams.length === 0) return teams;

  const teamIds = teams.map((t) => t.id);
  const members = await db('team_members as tm')
    .join('users as u', 'u.id', 'tm.user_id')
    .whereIn('tm.team_id', teamIds)
    .select('tm.*', 'u.first_name', 'u.last_name');

  const membersByTeam = {};
  for (const m of members) {
    (membersByTeam[m.team_id] ||= []).push(m);
  }

  return teams.map((t) => ({ ...t, members: membersByTeam[t.id] || [] }));
}

async function findById(db, id) {
  return db('teams').where({ id }).first();
}

async function create(db, data) {
  const [row] = await db('teams').insert(data).returning('*');
  return row;
}

async function addMember(db, teamId, userId, isDualAssigned = false) {
  const [row] = await db('team_members')
    .insert({ team_id: teamId, user_id: userId, is_dual_assigned: isDualAssigned })
    .returning('*');
  return row;
}

async function removeMember(db, teamId, userId) {
  await db('team_members').where({ team_id: teamId, user_id: userId }).delete();
}

module.exports = { findByEventDay, findById, create, addMember, removeMember };
