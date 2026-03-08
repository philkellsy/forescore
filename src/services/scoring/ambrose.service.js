'use strict';

function ambroseAllowance(memberCount) {
  if (memberCount === 2) return 1 / 4;
  if (memberCount === 3) return 1 / 3;
  return 0;
}

function toWholeShots(raw) {
  return Math.trunc(Number(raw) || 0);
}

async function calculateAmbroseLeaderboard(db, eventId) {
  const rows = await db('teams as t')
    .leftJoin('scorecards as s', 's.team_id', 't.id')
    .leftJoin('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .where({ 't.event_id': eventId, 't.competition_type': 'ambrose' })
    .groupBy('t.id', 't.name')
    .select('t.id', 't.name')
    .sum({ totalGross: 'sh.gross_score' });

  const teamIds = rows.map((r) => r.id);
  const memberRows = teamIds.length
    ? await db('team_members as tm')
        .leftJoin('player_handicaps as ph', function joinPh() {
          this.on('ph.user_id', '=', 'tm.user_id').andOnVal('ph.event_id', '=', eventId);
        })
        .whereIn('tm.team_id', teamIds)
        .select('tm.team_id', 'ph.playing_handicap')
    : [];

  const handicapByTeam = new Map();
  for (const teamId of teamIds) {
    const teamMembers = memberRows.filter((m) => Number(m.team_id) === Number(teamId));
    const total = teamMembers.reduce((sum, m) => sum + Number(m.playing_handicap || 0), 0);
    const allowance = ambroseAllowance(teamMembers.length);
    handicapByTeam.set(Number(teamId), toWholeShots(total * allowance));
  }

  const enriched = rows.map((r) => {
    const gross = Number(r.totalGross || 0);
    const handicap = handicapByTeam.get(Number(r.id)) || 0;
    return {
      ...r,
      teamHandicap: handicap,
      totalNet: gross - handicap
    };
  });

  return enriched.sort((a, b) => Number(a.totalNet || 0) - Number(b.totalNet || 0));
}

module.exports = { calculateAmbroseLeaderboard };
