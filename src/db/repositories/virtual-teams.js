'use strict';

async function findByTour(db, tourId) {
  const teams = await db('virtual_teams').where({ tour_id: tourId }).orderBy('name');
  if (!teams.length) return [];

  const players = await db('virtual_team_players as vtp')
    .join('virtual_teams as vt', 'vt.id', 'vtp.virtual_team_id')
    .join('users as u', 'u.id', 'vtp.user_id')
    .where('vt.tour_id', tourId)
    .select('vtp.virtual_team_id', 'vtp.user_id', 'u.first_name', 'u.last_name')
    .orderBy(['u.first_name', 'u.last_name']);

  const playersByTeam = new Map(teams.map((t) => [t.id, []]));
  for (const p of players) {
    if (playersByTeam.has(p.virtual_team_id)) {
      playersByTeam.get(p.virtual_team_id).push({
        userId: p.user_id,
        name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
      });
    }
  }

  return teams.map((t) => ({
    id: t.id,
    tourId: t.tour_id,
    name: t.name,
    players: playersByTeam.get(t.id) || [],
  }));
}

async function create(db, tourId, name) {
  const [team] = await db('virtual_teams').insert({ tour_id: tourId, name }).returning('*');
  return team;
}

async function rename(db, teamId, name) {
  await db('virtual_teams').where({ id: teamId }).update({ name, updated_at: db.fn.now() });
}

async function remove(db, teamId) {
  await db('virtual_teams').where({ id: teamId }).delete();
}

async function addPlayer(db, tourId, teamId, userId) {
  // Enforce one team per tour — remove from any other team in this tour first
  const otherTeamIds = await db('virtual_teams')
    .where({ tour_id: tourId })
    .whereNot({ id: teamId })
    .pluck('id');
  if (otherTeamIds.length) {
    await db('virtual_team_players')
      .whereIn('virtual_team_id', otherTeamIds)
      .where({ user_id: userId })
      .delete();
  }

  await db('virtual_team_players')
    .insert({ virtual_team_id: teamId, user_id: userId })
    .onConflict(['virtual_team_id', 'user_id']).ignore();
}

async function removePlayer(db, teamId, userId) {
  await db('virtual_team_players')
    .where({ virtual_team_id: teamId, user_id: userId })
    .delete();
}

module.exports = { findByTour, create, rename, remove, addPlayer, removePlayer };
