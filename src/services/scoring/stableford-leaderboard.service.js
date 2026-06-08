'use strict';

// Absolute back-9 hole numbers — countback always uses holes 10-18 regardless of starting hole
const BACK_9 = [10, 11, 12, 13, 14, 15, 16, 17, 18];

function holeSum(pointsByHole, holes) {
  return holes.reduce((sum, h) => sum + Number(pointsByHole.get(h) || 0), 0);
}

function countbackMetrics(pointsByHole) {
  return {
    last9: holeSum(pointsByHole, BACK_9),           // holes 10-18
    last6: holeSum(pointsByHole, BACK_9.slice(3)),  // holes 13-18
    last3: holeSum(pointsByHole, BACK_9.slice(6)),  // holes 16-18
    last1: holeSum(pointsByHole, BACK_9.slice(8)),  // hole 18
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

async function getStablefordRows(db, tourId, roundNumbers) {
  return db('scorecards as s')
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .join('users as u', 'u.id', 's.user_id')
    .where({ 's.tour_id': tourId, 's.type': 'individual', 's.status': 'submitted' })
    .whereIn('s.round_number', roundNumbers)
    .select(
      's.user_id',
      's.round_number',
      'u.first_name',
      'u.last_name',
      'sh.hole_number',
      'sh.stableford_points'
    );
}

function buildDayBoards(rows, days) {
  const byDay = new Map(days.map((d) => [d, new Map()]));

  for (const row of rows) {
    const day = Number(row.round_number);
    if (!byDay.has(day)) continue;
    const userId = Number(row.user_id);
    const dayMap = byDay.get(day);
    if (!dayMap.has(userId)) {
      dayMap.set(userId, {
        userId,
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        pointsByHole: new Map(),
      });
    }
    dayMap.get(userId).pointsByHole.set(Number(row.hole_number), Number(row.stableford_points || 0));
  }

  const boards = {};
  for (const day of days) {
    const rowsForDay = [...byDay.get(day).values()].map((entry) => {
      const metrics = countbackMetrics(entry.pointsByHole);
      const total = [...entry.pointsByHole.values()].reduce((sum, p) => sum + Number(p || 0), 0);
      return {
        userId: entry.userId,
        name: entry.name,
        total,
        countbackLast9: metrics.last9,
        countbackLast6: metrics.last6,
        countbackLast3: metrics.last3,
        countbackLast1: metrics.last1,
      };
    });
    boards[day] = withPosition(rowsForDay.sort(compareStablefordRows));
  }

  return boards;
}

// Returns { counting, dropped } for a player's rounds.
// When lastRoundRequired is true, the round with the highest round number is protected from
// being dropped — only other rounds are candidates. The last round is identified from the
// rounds array itself (max roundNumber), so it works correctly for any visible subset.
function selectCountingRounds(rounds, bestOf, lastRoundRequired) {
  if (!bestOf || bestOf >= rounds.length) {
    return { counting: rounds, dropped: [] };
  }
  if (lastRoundRequired) {
    const maxRoundNumber = Math.max(...rounds.map((r) => r.roundNumber));
    const lastRound = rounds.find((r) => r.roundNumber === maxRoundNumber);
    const others = rounds.filter((r) => r.roundNumber !== maxRoundNumber);
    const sortedOthers = [...others].sort((a, b) => b.total - a.total);
    const slotsForOthers = lastRound ? bestOf - 1 : bestOf;
    return {
      counting: lastRound ? [...sortedOthers.slice(0, slotsForOthers), lastRound] : sortedOthers.slice(0, slotsForOthers),
      dropped: sortedOthers.slice(slotsForOthers),
    };
  }
  const sorted = [...rounds].sort((a, b) => b.total - a.total);
  return { counting: sorted.slice(0, bestOf), dropped: sorted.slice(bestOf) };
}

// Sums only the counting rounds for each player.
// When bestOf is set, each player's worst round(s) are dropped; the returned rows include
// a droppedRounds Set of round numbers excluded from that player's total.
// When lastRoundRequired is true, the highest round number is protected from being dropped.
function buildChampionshipBoard(dayBoards, days, bestOf, lastRoundRequired) {
  const byUser = new Map();

  for (const day of days) {
    for (const row of dayBoards[day] || []) {
      const key = Number(row.userId);
      if (!byUser.has(key)) {
        byUser.set(key, { userId: key, name: row.name, rounds: [] });
      }
      byUser.get(key).rounds.push({
        roundNumber: day,
        total: Number(row.total || 0),
        countbackLast9: Number(row.countbackLast9 || 0),
        countbackLast6: Number(row.countbackLast6 || 0),
        countbackLast3: Number(row.countbackLast3 || 0),
        countbackLast1: Number(row.countbackLast1 || 0),
      });
    }
  }

  const result = [];
  for (const { userId, name, rounds } of byUser.values()) {
    const { counting, dropped } = selectCountingRounds(rounds, bestOf, lastRoundRequired);
    const droppedRounds = new Set(dropped.map((r) => r.roundNumber));

    const entry = { userId, name, total: 0, countbackLast9: 0, countbackLast6: 0, countbackLast3: 0, countbackLast1: 0, droppedRounds };
    for (const r of counting) {
      entry.total += r.total;
      entry.countbackLast9 += r.countbackLast9;
      entry.countbackLast6 += r.countbackLast6;
      entry.countbackLast3 += r.countbackLast3;
      entry.countbackLast1 += r.countbackLast1;
    }
    result.push(entry);
  }

  return withPosition(result.sort(compareStablefordRows));
}

// options.roundNumbers        — array of round numbers to include; required
// options.bestOf              — if set, each player's championship total uses only their best N rounds
// options.lastRoundRequired   — if true, the highest round number is protected from being dropped
async function calculateStablefordLeaderboards(db, tourId, { roundNumbers, bestOf, lastRoundRequired } = {}) {
  const activeRounds = roundNumbers && roundNumbers.length ? roundNumbers : [];
  const rows = await getStablefordRows(db, tourId, activeRounds);
  const byDay = buildDayBoards(rows, activeRounds);
  const championship = buildChampionshipBoard(byDay, activeRounds, bestOf, lastRoundRequired);
  return { byDay, championship };
}

module.exports = {
  calculateStablefordLeaderboards,
  // Exported for unit tests
  countbackMetrics,
  buildChampionshipBoard,
  selectCountingRounds,
};
