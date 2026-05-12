'use strict';

/**
 * Determines optimal group sizes for n players.
 * Prioritises groups of 4, splits remainder into groups of 3 to avoid 2-balls.
 * Only produces a 2-ball when mathematically unavoidable (n=2 or n=5).
 */
function groupSizes(n) {
  if (n <= 0) return [];
  if (n <= 2) return [n];
  if (n === 3) return [3];
  const r = n % 4;
  const q = Math.floor(n / 4);
  if (r === 0) return Array(q).fill(4);
  if (r === 3) return [...Array(q).fill(4), 3];
  if (r === 2) return [...Array(q - 1).fill(4), 3, 3];
  // r === 1: convert two 4-balls into three 3-balls to avoid a 1-ball
  if (q >= 2) return [...Array(q - 2).fill(4), 3, 3, 3];
  return [3, 2]; // n=5: unavoidable 2-ball
}

// Build a map of userId pair → times played together across all prior day groups.
// priorDayGroups is an array of groups, each with a players array of { user_id }.
function buildPairingsMatrix(priorDayGroups) {
  const matrix = new Map();
  for (const group of priorDayGroups) {
    const ids = (group.players || []).map((p) => Number(p.user_id));
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = `${Math.min(ids[i], ids[j])}_${Math.max(ids[i], ids[j])}`;
        matrix.set(key, (matrix.get(key) || 0) + 1);
      }
    }
  }
  return matrix;
}

function pairCost(a, b, matrix) {
  const key = `${Math.min(a, b)}_${Math.max(a, b)}`;
  return matrix.get(key) || 0;
}

function scoreCost(groups, matrix) {
  let total = 0;
  for (const group of groups) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        total += pairCost(group[i], group[j], matrix);
      }
    }
  }
  return total;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function assignToSizes(ids, sizes) {
  const groups = [];
  let idx = 0;
  for (const size of sizes) {
    groups.push(ids.slice(idx, idx + size));
    idx += size;
  }
  return groups;
}

/**
 * Assigns players to groups minimising repeat pairings from all prior days.
 *
 * players         — array of player objects with a user_id field
 * priorDayGroups  — flat array of all tee groups from previous days (each with .players)
 * sizes           — group size array from groupSizes(); computed if omitted
 * attempts        — number of random trials (default 80)
 *
 * Returns an array of player arrays (same objects as input).
 */
function distributeGroups(players, priorDayGroups, sizes, attempts = 80) {
  const matrix = buildPairingsMatrix(priorDayGroups || []);
  const ids = players.map((p) => Number(p.user_id));
  const resolvedSizes = sizes || groupSizes(ids.length);

  let bestGroups = null;
  let bestCost = Infinity;

  for (let i = 0; i < attempts; i += 1) {
    const shuffled = shuffle(ids);
    const groups = assignToSizes(shuffled, resolvedSizes);
    const cost = scoreCost(groups, matrix);
    if (cost < bestCost) {
      bestCost = cost;
      bestGroups = groups;
    }
    if (bestCost === 0) break; // perfect — no repeats possible
  }

  const playerById = new Map(players.map((p) => [Number(p.user_id), p]));
  return (bestGroups || []).map((group) => group.map((id) => playerById.get(id)));
}

/**
 * Assigns players to groups in reverse leaderboard order (worst score first).
 * Players not on the leaderboard are placed at the front (treated as worst).
 *
 * players     — array of player objects with a user_id field
 * leaderboard — array of { userId, position } (position 1 = leader)
 * sizes       — group size array; computed if omitted
 *
 * Returns an array of player arrays.
 */
function reverseLeaderboardGroups(players, leaderboard, sizes) {
  const positionOf = new Map((leaderboard || []).map((r) => [Number(r.userId), Number(r.position)]));
  const resolvedSizes = sizes || groupSizes(players.length);

  const sorted = [...players].sort((a, b) => {
    const aPos = positionOf.get(Number(a.user_id)) ?? Infinity;
    const bPos = positionOf.get(Number(b.user_id)) ?? Infinity;
    return bPos - aPos; // highest position number (worst) first
  });

  return assignToSizes(sorted, resolvedSizes);
}

module.exports = { groupSizes, distributeGroups, reverseLeaderboardGroups };
