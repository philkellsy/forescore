'use strict';

const { dayLabel } = require('../events/day-label.service');

function shuffleInPlace(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildSultansTeamName(members, fallbackIndex = 1) {
  const names = (members || [])
    .map((m) => String(m.last_name || '').trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!names.length) return `Sultans Team ${fallbackIndex}`;
  return names.join('/');
}

async function ensureSultansTeamsFromDay2(db, eventId) {
  const existing = await db('teams')
    .where({ event_id: eventId, day: 2, competition_type: 'sultans' })
    .count({ total: '*' })
    .first();
  if (Number(existing?.total || 0) > 0) return;

  const groups = await db('tee_groups')
    .where({ event_id: eventId, day: 2 })
    .orderBy([{ column: 'tee_time', order: 'asc' }, { column: 'starting_hole', order: 'asc' }, { column: 'group_number', order: 'asc' }])
    .select('id', 'group_number');
  if (!groups.length) return;

  const playersByGroup = new Map();
  const allBasePlayerIds = new Set();
  const groupIds = groups.map((g) => Number(g.id));
  const groupPlayers = await db('tee_group_players as tgp')
    .join('users as u', 'u.id', 'tgp.user_id')
    .whereIn('tgp.tee_group_id', groupIds)
    .orderBy([{ column: 'tgp.tee_group_id', order: 'asc' }, { column: 'tgp.position', order: 'asc' }])
    .select('tgp.tee_group_id', 'u.id', 'u.first_name', 'u.last_name');
  for (const row of groupPlayers) {
    const key = Number(row.tee_group_id);
    if (!playersByGroup.has(key)) playersByGroup.set(key, []);
    playersByGroup.get(key).push(row);
    allBasePlayerIds.add(Number(row.id));
  }

  const eventPlayers = await db('event_players as ep')
    .join('users as u', 'u.id', 'ep.user_id')
    .where({ 'ep.event_id': eventId })
    .select('u.id', 'u.first_name', 'u.last_name');
  const playersById = new Map(eventPlayers.map((p) => [Number(p.id), p]));

  const membershipCount = new Map();
  const teamRows = [];
  let teamCounter = 1;

  for (const group of groups) {
    const baseMembers = (playersByGroup.get(Number(group.id)) || []).map((m) => Number(m.id));
    if (!baseMembers.length) continue;

    const memberIds = [...baseMembers];
    baseMembers.forEach((id) => {
      membershipCount.set(id, Number(membershipCount.get(id) || 0) + 1);
    });

    while (memberIds.length < 4) {
      const eligible = eventPlayers
        .map((p) => Number(p.id))
        .filter((id) => !memberIds.includes(id))
        .filter((id) => Number(membershipCount.get(id) || 0) < 2);
      if (!eligible.length) break;
      const chosenId = shuffleInPlace(eligible)[0];
      memberIds.push(chosenId);
      membershipCount.set(chosenId, Number(membershipCount.get(chosenId) || 0) + 1);
    }

    const memberRecords = memberIds
      .map((id) => playersById.get(Number(id)))
      .filter(Boolean);
    const teamName = buildSultansTeamName(memberRecords, teamCounter);
    teamRows.push({
      groupId: Number(group.id),
      groupNumber: Number(group.group_number || teamCounter),
      memberIds,
      baseMemberSet: new Set(baseMembers),
      teamName
    });
    teamCounter += 1;
  }

  if (!teamRows.length) return;

  await db.transaction(async (trx) => {
    const existingTeamIds = await trx('teams')
      .where({ event_id: eventId, day: 2, competition_type: 'sultans' })
      .pluck('id');
    if (existingTeamIds.length) {
      await trx('team_members').whereIn('team_id', existingTeamIds).del();
      await trx('scorecards').where({ event_id: eventId, type: 'team' }).whereIn('team_id', existingTeamIds).del();
      await trx('teams').whereIn('id', existingTeamIds).del();
    }

    for (let idx = 0; idx < teamRows.length; idx += 1) {
      const team = teamRows[idx];
      const inserted = await trx('teams').insert({
        event_id: eventId,
        day: 2,
        competition_type: 'sultans',
        name: team.teamName,
        ambrose_group_id: null
      });
      const teamId = Number(Array.isArray(inserted) ? inserted[0] : inserted);

      for (const userId of team.memberIds) {
        await trx('team_members').insert({
          team_id: teamId,
          user_id: Number(userId),
          is_dual_assigned: !team.baseMemberSet.has(Number(userId))
        });
      }
    }
  });
}

async function calculateSultansLeaderboard(db, eventId, days = [2, 3, 4]) {
  // Self-heal legacy events where Day 2 was opened before Sultans auto-generation existed.
  // This keeps Sultans release behavior aligned with Eclectic once rounds are published.
  await ensureSultansTeamsFromDay2(db, eventId);

  const scopedDays = (Array.isArray(days) ? days : [2, 3, 4])
    .map((d) => Number(d))
    .filter((d) => [2, 3, 4].includes(d));
  if (!scopedDays.length) return [];

  const teams = await db('teams')
    .where({ event_id: eventId, day: 2, competition_type: 'sultans' })
    .orderBy('name', 'asc')
    .select('id', 'name');
  if (!teams.length) return [];

  const teamIds = teams.map((t) => Number(t.id));
  const members = await db('team_members')
    .whereIn('team_id', teamIds)
    .select('team_id', 'user_id');
  const membersByTeam = new Map();
  members.forEach((row) => {
    const teamId = Number(row.team_id);
    if (!membersByTeam.has(teamId)) membersByTeam.set(teamId, []);
    membersByTeam.get(teamId).push(Number(row.user_id));
  });

  const memberUserIds = [...new Set(members.map((m) => Number(m.user_id)))];
  if (!memberUserIds.length) return [];

  const holeRows = await db('scorecards as s')
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .where({ 's.event_id': eventId, 's.type': 'individual' })
    .whereIn('s.day', scopedDays)
    .whereIn('s.user_id', memberUserIds)
    .select('s.day', 's.user_id', 'sh.hole_number', 'sh.stableford_points');

  const pointsByDayUserHole = new Map();
  for (const row of holeRows) {
    const key = `${Number(row.day)}:${Number(row.user_id)}:${Number(row.hole_number)}`;
    pointsByDayUserHole.set(key, Number(row.stableford_points || 0));
  }

  const rows = teams.map((team) => {
    const teamId = Number(team.id);
    const teamMembers = membersByTeam.get(teamId) || [];
    const daily = {};
    let aggregate = 0;
    for (const day of scopedDays) {
      let dailyTotal = 0;
      for (let hole = 1; hole <= 18; hole += 1) {
        const holePoints = teamMembers
          .map((userId) => Number(pointsByDayUserHole.get(`${day}:${userId}:${hole}`) || 0))
          .sort((a, b) => b - a);
        const bestThree = holePoints.slice(0, 3);
        dailyTotal += bestThree.reduce((sum, p) => sum + Number(p || 0), 0);
      }
      daily[day] = dailyTotal;
      aggregate += dailyTotal;
    }
    return {
      id: teamId,
      name: team.name,
      days: daily,
      aggregate
    };
  });

  return rows.sort((a, b) => (
    Number(b.aggregate || 0) - Number(a.aggregate || 0) ||
    Number(b.days?.[4] || 0) - Number(a.days?.[4] || 0) ||
    Number(b.days?.[3] || 0) - Number(a.days?.[3] || 0) ||
    Number(b.days?.[2] || 0) - Number(a.days?.[2] || 0) ||
    String(a.name || '').localeCompare(String(b.name || ''))
  )).map((row, index) => ({
    ...row,
    position: index + 1,
    dayLabel: dayLabel(2)
  }));
}

module.exports = {
  ensureSultansTeamsFromDay2,
  calculateSultansLeaderboard
};
