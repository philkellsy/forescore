'use strict';

async function calculateAmbroseLeaderboard(db, eventId) {
  const rows = await db('teams as t')
    .leftJoin('scorecards as s', 's.team_id', 't.id')
    .leftJoin('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .where({ 't.event_id': eventId, 't.competition_type': 'ambrose' })
    .groupBy('t.id', 't.name')
    .select('t.id', 't.name')
    .sum({ totalGross: 'sh.gross_score' });

  return rows.sort((a, b) => Number(a.totalGross || 0) - Number(b.totalGross || 0));
}

module.exports = { calculateAmbroseLeaderboard };
