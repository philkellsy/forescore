'use strict';

async function calculateVirtualTeamResults(db, tourId, roundNumber) {
  const rows = await db('virtual_teams as vt')
    .where('vt.tour_id', tourId)
    .join('virtual_team_players as vtp', 'vtp.virtual_team_id', 'vt.id')
    .select('vt.id as team_id', 'vt.name as team_name', 'vtp.user_id');

  if (!rows.length) return [];

  // Only count players who have a scorecard for this round
  const scorecards = await db('scorecards')
    .where({ tour_id: tourId, round_number: roundNumber, type: 'individual' })
    .select('id', 'user_id');

  const scorecardByUser = new Map(scorecards.map((sc) => [sc.user_id, sc.id]));
  const scorecardIds = scorecards.map((sc) => sc.id);

  const holeTotals = scorecardIds.length
    ? await db('scorecard_holes')
        .whereIn('scorecard_id', scorecardIds)
        .groupBy('scorecard_id')
        .select('scorecard_id', db.raw('sum(stableford_points)::int as total'))
    : [];

  const pointsByScorecard = new Map(holeTotals.map((h) => [h.scorecard_id, Number(h.total || 0)]));

  const teamMap = new Map();
  for (const row of rows) {
    if (!teamMap.has(row.team_id)) {
      teamMap.set(row.team_id, { id: row.team_id, name: row.team_name, total: 0, playerCount: 0 });
    }
    const scId = scorecardByUser.get(row.user_id);
    if (scId !== undefined) {
      teamMap.get(row.team_id).playerCount += 1;
      teamMap.get(row.team_id).total += pointsByScorecard.get(scId) || 0;
    }
  }

  return [...teamMap.values()]
    .filter((t) => t.playerCount > 0)
    .map((t) => ({
      id: t.id,
      name: t.name,
      playerCount: t.playerCount,
      total: t.total,
      average: Math.round((t.total / t.playerCount) * 10) / 10,
    }))
    .sort((a, b) => b.average - a.average || a.name.localeCompare(b.name))
    .map((row, i) => ({ ...row, position: i + 1 }));
}

module.exports = { calculateVirtualTeamResults };
