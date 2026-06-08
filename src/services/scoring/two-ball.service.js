'use strict';

// Absolute back-9 hole numbers — matches the individual stableford countback convention
const BACK_9 = [10, 11, 12, 13, 14, 15, 16, 17, 18];

function holeSum(pointsByHole, holes) {
  return holes.reduce((sum, h) => sum + (pointsByHole.get(h) || 0), 0);
}

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

    // Build the pair's per-hole score (best-ball or aggregate) for total + countback
    const allHoles = new Set([...s1.pointsByHole.keys(), ...s2.pointsByHole.keys()]);
    const pairByHole = new Map();
    for (const hole of allHoles) {
      const pts1 = s1.pointsByHole.get(hole) || 0;
      const pts2 = s2.pointsByHole.get(hole) || 0;
      pairByHole.set(hole, twoBallType === 'best_ball' ? Math.max(pts1, pts2) : pts1 + pts2);
    }

    const total = [...pairByHole.values()].reduce((sum, v) => sum + v, 0);

    results.push({
      displayName: `${s1.name} & ${s2.name}`,
      total,
      countbackLast9: holeSum(pairByHole, BACK_9),
      countbackLast6: holeSum(pairByHole, BACK_9.slice(3)),
      countbackLast3: holeSum(pairByHole, BACK_9.slice(6)),
      countbackLast1: holeSum(pairByHole, BACK_9.slice(8)),
    });
  }

  results.sort((a, b) =>
    (b.total - a.total) ||
    (b.countbackLast9 - a.countbackLast9) ||
    (b.countbackLast6 - a.countbackLast6) ||
    (b.countbackLast3 - a.countbackLast3) ||
    (b.countbackLast1 - a.countbackLast1) ||
    String(a.displayName).localeCompare(String(b.displayName))
  );

  // Mark rows where countback separated a tie (same total as adjacent row)
  const totals = results.map((r) => r.total);
  return results.map((r, i) => ({
    ...r,
    position: i + 1,
    countbackApplied: r.total === totals[i - 1] || r.total === totals[i + 1],
  }));
}

module.exports = { calculateTwoBallLeaderboard };
