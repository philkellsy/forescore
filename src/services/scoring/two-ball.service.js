'use strict';

async function calculateTwoBallLeaderboard(db, tourId, roundNumber, twoBallType) {
  const groupPlayers = await db('tee_group_players as tgp')
    .join('tee_groups as tg', 'tg.id', 'tgp.tee_group_id')
    .where({ 'tg.tour_id': tourId, 'tg.round_number': roundNumber })
    .orderBy(['tg.id', 'tgp.position'])
    .select('tg.id as group_id', 'tgp.user_id', 'tgp.position');

  if (!groupPlayers.length) return [];

  const scorecardRows = await db('scorecards as s')
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .join('users as u', 'u.id', 's.user_id')
    .where({ 's.tour_id': tourId, 's.round_number': roundNumber, 's.type': 'individual', 's.status': 'submitted' })
    .select('s.user_id', 'u.first_name', 'u.last_name', 'sh.hole_number', 'sh.stableford_points');

  const scoresByUser = new Map();
  for (const row of scorecardRows) {
    const userId = Number(row.user_id);
    if (!scoresByUser.has(userId)) {
      scoresByUser.set(userId, {
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        pointsByHole: new Map(),
      });
    }
    scoresByUser.get(userId).pointsByHole.set(Number(row.hole_number), Number(row.stableford_points || 0));
  }

  const groupsMap = new Map();
  for (const row of groupPlayers) {
    const groupId = Number(row.group_id);
    if (!groupsMap.has(groupId)) groupsMap.set(groupId, []);
    groupsMap.get(groupId).push({ userId: Number(row.user_id), position: Number(row.position) });
  }

  const pairs = [];
  for (const [, players] of groupsMap) {
    const sorted = players.sort((a, b) => a.position - b.position);
    if (sorted.length >= 2) pairs.push([sorted[0], sorted[1]]);
    if (sorted.length >= 4) pairs.push([sorted[2], sorted[3]]);
  }

  const results = [];
  for (const [p1, p2] of pairs) {
    const s1 = scoresByUser.get(p1.userId);
    const s2 = scoresByUser.get(p2.userId);
    if (!s1 || !s2) continue;

    const allHoles = new Set([...s1.pointsByHole.keys(), ...s2.pointsByHole.keys()]);
    let total = 0;
    for (const hole of allHoles) {
      const pts1 = s1.pointsByHole.get(hole) || 0;
      const pts2 = s2.pointsByHole.get(hole) || 0;
      total += twoBallType === 'best_ball' ? Math.max(pts1, pts2) : pts1 + pts2;
    }

    results.push({ displayName: `${s1.name} & ${s2.name}`, total });
  }

  results.sort((a, b) => b.total - a.total);
  return results.map((r, i) => ({ ...r, position: i + 1 }));
}

module.exports = { calculateTwoBallLeaderboard };
