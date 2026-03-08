'use strict';

function holeSequenceFrom(startingHole) {
  const start = Math.min(18, Math.max(1, Number(startingHole) || 1));
  const seq = [];
  for (let i = 0; i < 18; i += 1) {
    seq.push(((start - 1 + i) % 18) + 1);
  }
  return seq;
}

function segmentSum(pointsByHole, sequence, size) {
  const segment = sequence.slice(Math.max(0, sequence.length - size));
  return segment.reduce((sum, hole) => sum + Number(pointsByHole.get(hole) || 0), 0);
}

function countbackMetrics(pointsByHole, startingHole) {
  const sequence = holeSequenceFrom(startingHole);
  return {
    last9: segmentSum(pointsByHole, sequence, 9),
    last6: segmentSum(pointsByHole, sequence, 6),
    last3: segmentSum(pointsByHole, sequence, 3),
    last1: segmentSum(pointsByHole, sequence, 1)
  };
}

function compareStablefordRows(a, b) {
  return (
    Number(b.total || 0) - Number(a.total || 0) ||
    Number(b.countbackLast9 || 0) - Number(a.countbackLast9 || 0) ||
    Number(b.countbackLast6 || 0) - Number(a.countbackLast6 || 0) ||
    Number(b.countbackLast3 || 0) - Number(a.countbackLast3 || 0) ||
    Number(b.countbackLast1 || 0) - Number(a.countbackLast1 || 0) ||
    String(a.name || '').localeCompare(String(b.name || ''))
  );
}

function withPosition(rows) {
  return rows.map((row, index) => ({ ...row, position: index + 1 }));
}

async function getStartingHolesByUserDay(db, eventId) {
  const rows = await db('tee_group_players as tgp')
    .join('tee_groups as tg', 'tg.id', 'tgp.tee_group_id')
    .where({ 'tg.event_id': eventId })
    .whereIn('tg.day', [2, 3, 4])
    .select('tgp.user_id', 'tg.day', 'tg.starting_hole');

  const map = new Map();
  for (const row of rows) {
    map.set(`${Number(row.user_id)}:${Number(row.day)}`, Number(row.starting_hole || 1));
  }
  return map;
}

async function getStablefordRows(db, eventId) {
  return db('scorecards as s')
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .join('users as u', 'u.id', 's.user_id')
    .where({ 's.event_id': eventId, 's.type': 'individual' })
    .whereIn('s.day', [2, 3, 4])
    .select(
      's.user_id',
      's.day',
      'u.first_name',
      'u.last_name',
      'sh.hole_number',
      'sh.stableford_points'
    );
}

function buildDayBoards(rows, startingByUserDay) {
  const byDay = new Map([[2, new Map()], [3, new Map()], [4, new Map()]]);

  for (const row of rows) {
    const day = Number(row.day);
    if (!byDay.has(day)) continue;
    const userId = Number(row.user_id);
    const key = `${userId}`;
    const dayMap = byDay.get(day);
    if (!dayMap.has(key)) {
      dayMap.set(key, {
        userId,
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        pointsByHole: new Map()
      });
    }
    dayMap.get(key).pointsByHole.set(Number(row.hole_number), Number(row.stableford_points || 0));
  }

  const boards = {};
  [2, 3, 4].forEach((day) => {
    const rowsForDay = [...byDay.get(day).values()].map((entry) => {
      const startingHole = startingByUserDay.get(`${entry.userId}:${day}`) || 1;
      const metrics = countbackMetrics(entry.pointsByHole, startingHole);
      const total = [...entry.pointsByHole.values()].reduce((sum, p) => sum + Number(p || 0), 0);
      return {
        userId: entry.userId,
        name: entry.name,
        total,
        countbackLast9: metrics.last9,
        countbackLast6: metrics.last6,
        countbackLast3: metrics.last3,
        countbackLast1: metrics.last1
      };
    });

    boards[day] = withPosition(rowsForDay.sort(compareStablefordRows));
  });

  return boards;
}

function buildChampionshipBoard(dayBoards) {
  const byUser = new Map();
  [2, 3, 4].forEach((day) => {
    (dayBoards[day] || []).forEach((row) => {
      const key = Number(row.userId);
      if (!byUser.has(key)) {
        byUser.set(key, {
          userId: key,
          name: row.name,
          total: 0,
          countbackLast9: 0,
          countbackLast6: 0,
          countbackLast3: 0,
          countbackLast1: 0
        });
      }
      const target = byUser.get(key);
      target.total += Number(row.total || 0);
      target.countbackLast9 += Number(row.countbackLast9 || 0);
      target.countbackLast6 += Number(row.countbackLast6 || 0);
      target.countbackLast3 += Number(row.countbackLast3 || 0);
      target.countbackLast1 += Number(row.countbackLast1 || 0);
    });
  });

  return withPosition([...byUser.values()].sort(compareStablefordRows));
}

async function calculateStablefordLeaderboards(db, eventId) {
  const [rows, startingByUserDay] = await Promise.all([
    getStablefordRows(db, eventId),
    getStartingHolesByUserDay(db, eventId)
  ]);
  const byDay = buildDayBoards(rows, startingByUserDay);
  const championship = buildChampionshipBoard(byDay);
  return { byDay, championship };
}

module.exports = {
  calculateStablefordLeaderboards
};
