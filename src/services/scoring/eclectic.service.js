'use strict';

async function calculateEclecticLeaderboard(db, tourId, roundNumbers = []) {
  if (!roundNumbers.length) return [];

  const rows = await db('scorecards as s')
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .join('users as u', 'u.id', 's.user_id')
    .where('s.tour_id', tourId)
    .whereIn('s.round_number', roundNumbers)
    .andWhere('s.type', 'individual')
    .select(
      's.user_id',
      'u.first_name',
      'u.last_name',
      'sh.hole_number',
      'sh.stableford_points'
    );

  const byUserHole = new Map();
  for (const row of rows) {
    const userId = Number(row.user_id);
    const holeNumber = Number(row.hole_number);
    const points = Number(row.stableford_points || 0);
    const key = `${userId}:${holeNumber}`;
    const existing = byUserHole.get(key);
    if (!existing || points > existing.bestStableford) {
      byUserHole.set(key, {
        userId,
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        holeNumber,
        bestStableford: points
      });
    }
  }

  const totalsByUser = new Map();
  for (const row of byUserHole.values()) {
    if (!totalsByUser.has(row.userId)) {
      totalsByUser.set(row.userId, { userId: row.userId, name: row.name, totalPoints: 0 });
    }
    totalsByUser.get(row.userId).totalPoints += Number(row.bestStableford || 0);
  }

  return [...totalsByUser.values()].sort((a, b) => (
    Number(b.totalPoints || 0) - Number(a.totalPoints || 0) ||
    String(a.name || '').localeCompare(String(b.name || ''))
  ));
}

module.exports = { calculateEclecticLeaderboard };
