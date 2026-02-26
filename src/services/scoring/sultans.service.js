'use strict';

async function calculateSultansLeaderboard(db, eventId) {
  // Placeholder aggregator until full virtual-team builder is implemented.
  const rows = await db('teams as t')
    .leftJoin('scorecards as s', 's.team_id', 't.id')
    .leftJoin('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .where({ 't.event_id': eventId, 't.competition_type': 'sultans' })
    .groupBy('t.id', 't.name')
    .select('t.id', 't.name')
    .sum({ aggregate: 'sh.stableford_points' });

  return rows.sort((a, b) => Number(a.aggregate || 0) - Number(b.aggregate || 0));
}

module.exports = { calculateSultansLeaderboard };
