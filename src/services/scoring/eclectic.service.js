'use strict';

async function calculateEclecticLeaderboard(db, eventId) {
  const rows = await db('scorecards as s')
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .join('users as u', 'u.id', 's.user_id')
    .where('s.event_id', eventId)
    .whereIn('s.day', [2, 3, 4])
    .andWhere('s.type', 'individual')
    .select('s.user_id', 'u.first_name', 'u.last_name', 'sh.hole_number')
    .min({ bestGross: 'sh.gross_score' });

  const totals = new Map();
  for (const row of rows) {
    const key = row.user_id;
    if (!totals.has(key)) totals.set(key, { userId: key, name: `${row.first_name} ${row.last_name}`, totalGross: 0 });
    totals.get(key).totalGross += Number(row.bestGross || 0);
  }

  return [...totals.values()].sort((a, b) => a.totalGross - b.totalGross);
}

module.exports = { calculateEclecticLeaderboard };
