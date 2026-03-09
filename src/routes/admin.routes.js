'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/authorize');
const { ROLES } = require('../config/roles');
const { CALC_TYPES, defaultCalcTypeForDay } = require('../config/calc-types');
const { dayLabel } = require('../services/events/day-label.service');
const { markLeaderboardDirty } = require('../services/leaderboard/dirty.service');
const { calculateAmbroseLeaderboard } = require('../services/scoring/ambrose.service');
const { calculateStablefordLeaderboards } = require('../services/scoring/stableford-leaderboard.service');
const { calculateEclecticLeaderboard } = require('../services/scoring/eclectic.service');
const { calculateSultansLeaderboard, ensureSultansTeamsFromDay2 } = require('../services/scoring/sultans.service');
const { calculateEventSkinsForDays } = require('../services/scoring/skins.service');
const { stablefordPoints } = require('../services/scoring/stableford.service');
const { strokesForHole } = require('../services/scoring/handicap.service');
const { createDay2Order } = require('../services/draw/calcutta.service');

const ALLOWED_ROLES = [ROLES.PLAYER, ROLES.SCORER, ROLES.ADMIN];
const GENERATED_TEE_TIME_GAP_MINUTES = 10;
const BONVILLE_WHITE_HOLES = [
  { hole: 1, par: 4, si: 2, meters: 358 },
  { hole: 2, par: 3, si: 18, meters: 174 },
  { hole: 3, par: 4, si: 12, meters: 331 },
  { hole: 4, par: 5, si: 14, meters: 470 },
  { hole: 5, par: 3, si: 18, meters: 140 },
  { hole: 6, par: 4, si: 6, meters: 329 },
  { hole: 7, par: 5, si: 16, meters: 460 },
  { hole: 8, par: 3, si: 4, meters: 176 },
  { hole: 9, par: 4, si: 10, meters: 320 },
  { hole: 10, par: 5, si: 13, meters: 444 },
  { hole: 11, par: 3, si: 9, meters: 150 },
  { hole: 12, par: 4, si: 1, meters: 387 },
  { hole: 13, par: 4, si: 3, meters: 364 },
  { hole: 14, par: 5, si: 15, meters: 475 },
  { hole: 15, par: 4, si: 7, meters: 341 },
  { hole: 16, par: 4, si: 5, meters: 366 },
  { hole: 17, par: 3, si: 11, meters: 137 },
  { hole: 18, par: 5, si: 17, meters: 454 }
];
const TEST_DATA_EVENT_ID = 1;
const TEST_DATA_OWNER_USER_ID = 1;
const TEST_DATA_PLAYER_COUNT = 24;
const TEST_DATA_EMAIL_PREFIX = 'legends-seed-player-';
const TEST_FIRST_NAMES = [
  'Oliver', 'Jack', 'Harry', 'Noah', 'Thomas',
  'Charlie', 'William', 'Lucas', 'James', 'Henry',
  'Liam', 'Mason', 'Ethan', 'Leo', 'Max',
  'Cooper', 'Hudson', 'Finn', 'Samuel', 'Xavier',
  'Patrick', 'Nate', 'Jordan', 'Ben', 'Isaac'
];
const TEST_LAST_NAMES = [
  'Anderson', 'Bennett', 'Campbell', 'Davies', 'Edwards',
  'Fletcher', 'Griffin', 'Hughes', 'Irwin', 'Johnson',
  'Kerr', 'Lawson', 'Mitchell', 'Nolan', 'Owens',
  'Parker', 'Quinn', 'Reynolds', 'Stewart', 'Turner',
  'Underwood', 'Vaughan', 'Walker', 'Young', 'Zimmerman'
];
const NOVELTY_TYPES = Object.freeze({
  NTP: 'NTP',
  LONG_DRIVE: 'Long Drive'
});

function isSeedToolUser(user) {
  return Number(user?.id || 0) === TEST_DATA_OWNER_USER_ID;
}

function ensureSeedToolUser(req, res, next) {
  if (!isSeedToolUser(req.session?.user)) return res.status(403).send('Forbidden');
  return next();
}

function ambroseAllowance(memberCount) {
  if (Number(memberCount) === 2) return 1 / 4;
  if (Number(memberCount) === 3) return 1 / 3;
  return 0;
}

function toWholeShots(raw) {
  return Math.trunc(Number(raw) || 0);
}

function normalizeMobile(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits || null;
}

function testSeedEmail(index) {
  return `${TEST_DATA_EMAIL_PREFIX}${String(index).padStart(2, '0')}@example.test`;
}

function testSeedFirstName(index) {
  const i = Math.max(1, Number(index) || 1) - 1;
  return TEST_FIRST_NAMES[i % TEST_FIRST_NAMES.length];
}

function testSeedLastName(index) {
  const i = Math.max(1, Number(index) || 1) - 1;
  return TEST_LAST_NAMES[i % TEST_LAST_NAMES.length];
}

function seededHandicapForIndex(index, total) {
  const safeTotal = Math.max(1, Number(total) || 1);
  const idx = Math.max(0, Number(index) || 0);

  // Reserve one plus-marker player for testing.
  if (idx === 0) return -1;

  // Remaining players: 7..26, skewed lower with an average around 13.
  const regularCount = Math.max(1, safeTotal - 1);
  const regularIndex = Math.min(regularCount - 1, idx - 1);
  const ratio = regularCount <= 1 ? 0 : (regularIndex / (regularCount - 1));
  const min = 7;
  const max = 26;
  const exponent = 1.9;
  const weighted = Math.pow(ratio, exponent);
  return Math.round(min + ((max - min) * weighted));
}

function createTestGroupSizes(totalPlayers) {
  const total = Number(totalPlayers || 0);
  if (total <= 0) return [];
  const sizes = [];
  let remaining = total;
  while (remaining > 0) {
    if (remaining === 5) {
      sizes.push(3, 2);
      break;
    }
    if (remaining === 2) {
      sizes.push(2);
      break;
    }
    if (remaining === 1) {
      sizes.push(1);
      break;
    }
    if (remaining % 4 === 1) {
      sizes.push(3);
      remaining -= 3;
      continue;
    }
    if (remaining % 4 === 2 && remaining > 6) {
      sizes.push(3);
      remaining -= 3;
      continue;
    }
    const next = Math.min(4, remaining);
    sizes.push(next);
    remaining -= next;
  }
  return sizes;
}

function getCalcuttaPendingMap(req) {
  if (!req.session.calcuttaPendingByEvent || typeof req.session.calcuttaPendingByEvent !== 'object') {
    req.session.calcuttaPendingByEvent = {};
  }
  return req.session.calcuttaPendingByEvent;
}

function getPendingCalcuttaUserId(req, eventId) {
  const map = getCalcuttaPendingMap(req);
  const value = Number(map[String(eventId)] || 0);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function setPendingCalcuttaUserId(req, eventId, userId) {
  const map = getCalcuttaPendingMap(req);
  map[String(eventId)] = Number(userId);
}

function clearPendingCalcuttaUserId(req, eventId) {
  const map = getCalcuttaPendingMap(req);
  delete map[String(eventId)];
}

function buildDay2DrawGroupSizes(totalPlayers) {
  const total = Number(totalPlayers || 0);
  if (total <= 0) return [];
  if (total < 3) return [total];

  const solveNoTwos = (n, fixedFirstFour) => {
    const target = Number(n || 0);
    const base = [];
    let remaining = target;
    if (fixedFirstFour) {
      if (target < 4) return null;
      base.push(4);
      remaining -= 4;
    }
    let best = null;
    // Prefer more 4-balls by minimizing 3-ball count.
    for (let threes = 0; threes <= Math.floor(remaining / 3); threes += 1) {
      const rem = remaining - (threes * 3);
      if (rem < 0 || rem % 4 !== 0) continue;
      const fours = rem / 4;
      const sizes = [...base];
      for (let i = 0; i < fours; i += 1) sizes.push(4);
      for (let i = 0; i < threes; i += 1) sizes.push(3);
      if (!best || threes < best.threes) best = { sizes, threes };
    }
    return best ? best.sizes : null;
  };

  // First preference: keep Group 1 as a 4-ball.
  let sizes = solveNoTwos(total, true);
  // Fallback: still avoid 2-balls even if Group 1 cannot be 4.
  if (!sizes) sizes = solveNoTwos(total, false);
  if (!sizes) {
    throw new Error(`Unable to create Day 2 groups without 2-balls for ${total} players`);
  }
  return sizes;
}

async function generateDay2GroupsFromCalcuttaDraw(db, eventId) {
  const dayStatus = await getOrCreateDayStatus(db, eventId, 2);
  if (String(dayStatus.status || 'draft') !== 'draft') {
    throw new Error('Day 2 must be in Draft before generating groups from Calcutta');
  }

  const eventPlayers = await db('event_players')
    .where({ event_id: eventId, status: 'active' })
    .select('user_id');
  const activePlayerIds = eventPlayers.map((r) => Number(r.user_id));
  if (!activePlayerIds.length) throw new Error('No active players in this event');

  const drawnRows = await createDay2Order(db, eventId);
  if (drawnRows.length < activePlayerIds.length) {
    throw new Error('Not all players have been drawn in Calcutta yet');
  }

  const activeSet = new Set(activePlayerIds);
  let orderedPlayerIds = drawnRows
    .map((row) => Number(row.auctioned_user_id))
    .filter((id) => activeSet.has(id));
  orderedPlayerIds = [...new Set(orderedPlayerIds)];
  if (orderedPlayerIds.length !== activePlayerIds.length) {
    throw new Error('Calcutta draw does not include all active event players');
  }

  const defendingChampion = await db('event_players')
    .where({ event_id: eventId, is_previous_year_winner: 1 })
    .select('user_id')
    .first();
  const championId = Number(defendingChampion?.user_id || 0);
  if (championId && orderedPlayerIds.includes(championId)) {
    orderedPlayerIds = [championId, ...orderedPlayerIds.filter((id) => id !== championId)];
  }

  const sizes = buildDay2DrawGroupSizes(orderedPlayerIds.length);
  if (sizes.some((size) => Number(size) < 3)) {
    throw new Error('Day 2 generation would create a 2-ball or single. Adjust player count and try again.');
  }
  await db.transaction(async (trx) => {
    await trx('tee_groups').where({ event_id: eventId, day: 2 }).del();
    const nextTeeTime = createPerTeeTimeAllocator('10:00');
    let offset = 0;
    for (let i = 0; i < sizes.length; i += 1) {
      const size = Number(sizes[i] || 0);
      if (size <= 0) continue;
      const chunk = orderedPlayerIds.slice(offset, offset + size);
      offset += size;
      const { startingHole, teeLocation } = splitStartMeta(i);
      const ids = await trx('tee_groups').insert({
        event_id: eventId,
        day: 2,
        group_number: i + 1,
        tee_time: nextTeeTime(startingHole),
        tee_location: teeLocation,
        starting_hole: startingHole,
        source: 'calcutta_draw'
      });
      const groupId = Number(Array.isArray(ids) ? ids[0] : ids);
      for (let pos = 0; pos < chunk.length; pos += 1) {
        await trx('tee_group_players').insert({
          tee_group_id: groupId,
          user_id: Number(chunk[pos]),
          position: pos + 1
        });
      }
    }
  });
}

async function buildCalcuttaViewState(db, req, eventId) {
  const event = await db('events').where({ id: eventId }).first();
  if (!event) return null;

  const eventPlayers = await db('event_players as ep')
    .join('users as u', 'u.id', 'ep.user_id')
    .leftJoin('player_handicaps as ph', function joinPh() {
      this.on('ph.user_id', '=', 'ep.user_id').andOnVal('ph.event_id', '=', eventId);
    })
    .where({ 'ep.event_id': eventId, 'ep.status': 'active' })
    .orderBy([{ column: 'u.last_name', order: 'asc' }, { column: 'u.first_name', order: 'asc' }])
    .select(
      'u.id',
      'u.first_name',
      'u.last_name',
      'u.is_previous_winner',
      'ep.is_previous_year_winner',
      'ph.playing_handicap'
    );
  const playerMap = new Map(eventPlayers.map((p) => [Number(p.id), p]));

  const sales = await db('calcutta_auctions as ca')
    .join('users as auctioned', 'auctioned.id', 'ca.auctioned_user_id')
    .join('users as buyer', 'buyer.id', 'ca.buyer_user_id')
    .leftJoin('users as owner', 'owner.id', 'ca.owner_user_id')
    .leftJoin('event_players as ep_auctioned', function joinAuctionedEventPlayer() {
      this.on('ep_auctioned.user_id', '=', 'ca.auctioned_user_id').andOnVal('ep_auctioned.event_id', '=', eventId);
    })
    .leftJoin('player_handicaps as ph', function joinAuctionedHcp() {
      this.on('ph.user_id', '=', 'ca.auctioned_user_id').andOnVal('ph.event_id', '=', eventId);
    })
    .where({ 'ca.event_id': eventId })
    .orderBy('ca.draw_order', 'asc')
    .select(
      'ca.id',
      'ca.auctioned_user_id',
      'ca.buyer_user_id',
      'ca.owner_user_id',
      'ca.auction_bid_amount',
      'ca.draw_order',
      'auctioned.is_previous_winner as auctioned_is_previous_winner',
      'ep_auctioned.is_previous_year_winner as auctioned_is_previous_year_winner',
      'auctioned.first_name as auctioned_first_name',
      'auctioned.last_name as auctioned_last_name',
      'buyer.first_name as buyer_first_name',
      'buyer.last_name as buyer_last_name',
      'owner.first_name as owner_first_name',
      'owner.last_name as owner_last_name',
      'ph.playing_handicap as auctioned_playing_handicap'
    );

  const soldSet = new Set(sales.map((s) => Number(s.auctioned_user_id)));
  const pendingUserId = getPendingCalcuttaUserId(req, eventId);
  const pendingPlayer = pendingUserId && playerMap.has(Number(pendingUserId))
    ? playerMap.get(Number(pendingUserId))
    : null;
  if (pendingUserId && !pendingPlayer) {
    clearPendingCalcuttaUserId(req, eventId);
  }

  const remainingPlayers = eventPlayers.filter((p) => !soldSet.has(Number(p.id)));
  const totalPlayers = eventPlayers.length;
  const drawnPlayers = sales.length;
  const allDrawn = totalPlayers > 0 && drawnPlayers >= totalPlayers;
  const ownerMissingCount = sales.filter((row) => !row.owner_user_id).length;
  const soldTotal = sales.reduce((sum, row) => sum + Number(row.auction_bid_amount || 0), 0);
  const poolTotal = soldTotal * 0.5;
  const day2GroupCountRow = await db('tee_groups')
    .where({ event_id: eventId, day: 2, source: 'calcutta_draw' })
    .count({ total: '*' })
    .first();
  const day2GroupCount = Number(day2GroupCountRow?.total || 0);
  const day2Status = await getOrCreateDayStatus(db, eventId, 2);
  const day2GroupAssignments = new Map();
  if (day2GroupCount > 0) {
    const day2Rows = await db('tee_groups as tg')
      .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
      .where({ 'tg.event_id': eventId, 'tg.day': 2, 'tg.source': 'calcutta_draw' })
      .orderBy([{ column: 'tg.group_number', order: 'asc' }, { column: 'tgp.position', order: 'asc' }])
      .select('tg.group_number', 'tgp.user_id');
    day2Rows.forEach((row) => {
      day2GroupAssignments.set(Number(row.user_id), Number(row.group_number || 0));
    });
  }

  return {
    event,
    eventPlayers,
    sales,
    pendingPlayer,
    remainingPlayers,
    totalPlayers,
    drawnPlayers,
    allDrawn,
    ownerMissingCount,
    soldTotal,
    poolTotal,
    day2GroupCount,
    day2Status,
    day2GroupAssignments
  };
}

async function ensureEventExists(db, eventId) {
  const event = await db('events').where({ id: eventId }).first();
  if (!event) throw new Error(`Event ${eventId} not found`);
  return event;
}

async function ensureDayStatusRows(db, eventId) {
  const defaultCourse = await db('courses').orderBy('id', 'asc').first();
  if (!defaultCourse) throw new Error('No courses configured');
  for (const day of [1, 2, 3, 4]) {
    await getOrCreateDayStatus(db, eventId, day);
  }
}

async function listSeedUsers(db) {
  return db('users')
    .where('email', 'like', `${TEST_DATA_EMAIL_PREFIX}%`)
    .orderBy('id', 'asc')
    .select('id', 'first_name', 'last_name', 'email');
}

async function listSeedPlayerIdsForEvent(db, eventId) {
  const rows = await db('event_players as ep')
    .join('users as u', 'u.id', 'ep.user_id')
    .where({ 'ep.event_id': eventId })
    .where((q) => {
      q.where('u.id', TEST_DATA_OWNER_USER_ID).orWhere('u.email', 'like', `${TEST_DATA_EMAIL_PREFIX}%`);
    })
    .orderBy([{ column: 'u.id', order: 'asc' }])
    .select('u.id');
  return rows.map((r) => Number(r.id));
}

async function buildEventPlayersWithProfile(db, eventId) {
  const rows = await db('event_players as ep')
    .join('users as u', 'u.id', 'ep.user_id')
    .leftJoin('player_handicaps as ph', function joinPh() {
      this.on('ph.user_id', '=', 'u.id').andOnVal('ph.event_id', '=', eventId);
    })
    .where({ 'ep.event_id': eventId })
    .where((q) => q.where('u.id', TEST_DATA_OWNER_USER_ID).orWhere('u.email', 'like', `${TEST_DATA_EMAIL_PREFIX}%`))
    .orderBy([{ column: 'u.last_name', order: 'asc' }, { column: 'u.first_name', order: 'asc' }])
    .select('u.id', 'u.first_name', 'u.last_name', 'ph.playing_handicap');
  return rows.map((row, idx) => ({ ...row, orderIndex: idx }));
}

function splitStartMeta(index) {
  const startingHole = index % 2 === 0 ? 1 : 9;
  return {
    startingHole,
    teeLocation: startingHole === 1 ? '1st tee' : '9th tee'
  };
}

function createPerTeeTimeAllocator(baseTime) {
  const fallbackMinutes = parseTimeToMinutes('10:00') ?? 600;
  const baseMinutes = parseTimeToMinutes(String(baseTime || '10:00')) ?? fallbackMinutes;
  const byStartingHole = new Map();
  return (startingHole) => {
    const hole = Number(startingHole || 1);
    const current = byStartingHole.has(hole) ? Number(byStartingHole.get(hole)) : baseMinutes;
    byStartingHole.set(hole, current + GENERATED_TEE_TIME_GAP_MINUTES);
    return minutesToTime(current);
  };
}

function seededRoll(...parts) {
  let hash = 2166136261 >>> 0;
  for (const part of parts) {
    const value = Number(part) || 0;
    hash ^= (value + 0x9e3779b9 + ((hash << 6) >>> 0) + (hash >>> 2)) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % 100;
}

function seededStablefordDelta(roll) {
  const r = Number(roll) % 100;
  // Hole-level variance tuned so seeded championship winners land around
  // 105-108 over 3 rounds for a ~26 player field.
  if (r < 3) return -2;
  if (r < 19) return -1;
  if (r < 60) return 0;
  if (r < 86) return 1;
  if (r < 96) return 2;
  return 3;
}

function shuffleArray(values) {
  const arr = [...values];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function clearScorecardsForDay(db, eventId, day, type) {
  let query = db('scorecards').where({ event_id: eventId, day });
  if (type) query = query.andWhere({ type });
  const ids = await query.pluck('id');
  if (!ids.length) return;
  await db('ambrose_drives').whereIn('scorecard_id', ids).del();
  await db('scorecard_holes').whereIn('scorecard_id', ids).del();
  await db('scorecards').whereIn('id', ids).del();
}

async function clearDayGroups(db, eventId, day) {
  await clearScorecardsForDay(db, eventId, day, 'individual');
  await db('tee_groups').where({ event_id: eventId, day }).del();
}

async function createIndividualGroups(db, eventId, day, playerIds) {
  await clearDayGroups(db, eventId, day);
  const sizes = createTestGroupSizes(playerIds.length);
  let offset = 0;
  const nextTeeTime = createPerTeeTimeAllocator('10:00');
  for (let i = 0; i < sizes.length; i += 1) {
    const groupPlayers = playerIds.slice(offset, offset + sizes[i]);
    offset += sizes[i];
    const { startingHole, teeLocation } = splitStartMeta(i);
    const ids = await db('tee_groups').insert({
      event_id: eventId,
      day,
      group_number: i + 1,
      tee_time: nextTeeTime(startingHole),
      tee_location: teeLocation,
      starting_hole: startingHole,
      source: 'test_seed'
    });
    const groupId = Number(Array.isArray(ids) ? ids[0] : ids);
    for (let p = 0; p < groupPlayers.length; p += 1) {
      await db('tee_group_players').insert({
        tee_group_id: groupId,
        user_id: Number(groupPlayers[p]),
        position: p + 1
      });
    }
  }
  return sizes.length;
}

async function createAmbroseGroupsAndTeams(db, eventId, playerProfiles) {
  await clearScorecardsForDay(db, eventId, 1, 'team');
  await db('teams').where({ event_id: eventId, day: 1, competition_type: 'ambrose' }).del();
  await db('ambrose_groups').where({ event_id: eventId, day: 1 }).del();

  const totalPlayers = playerProfiles.length;
  const teamSizes = [];
  if (totalPlayers % 2 === 0) {
    for (let i = 0; i < totalPlayers / 2; i += 1) teamSizes.push(2);
  } else {
    const twoBallTeams = Math.max(0, (totalPlayers - 3) / 2);
    for (let i = 0; i < twoBallTeams; i += 1) teamSizes.push(2);
    teamSizes.push(3); // Put the 3-ball at the back of the field.
  }
  // Build mixed-handicap teams by pairing high and low markers.
  const sortedPool = [...playerProfiles].sort((a, b) => (
    Number(b.playing_handicap || 0) - Number(a.playing_handicap || 0)
      || String(a.last_name || '').localeCompare(String(b.last_name || ''))
      || String(a.first_name || '').localeCompare(String(b.first_name || ''))
  ));
  const takeMiddle = (arr) => {
    if (!arr.length) return null;
    const mid = Math.floor((arr.length - 1) / 2);
    const [picked] = arr.splice(mid, 1);
    return picked || null;
  };
  const teamBuckets = [];
  for (const size of teamSizes) {
    const team = [];
    if (size >= 1 && sortedPool.length) team.push(sortedPool.shift()); // highest
    if (size >= 2 && sortedPool.length) team.push(sortedPool.pop()); // lowest
    while (team.length < size && sortedPool.length) {
      const middle = takeMiddle(sortedPool);
      if (!middle) break;
      team.push(middle);
    }
    if (team.length) teamBuckets.push(team);
  }

  const groupCount = Math.ceil(teamBuckets.length / 2);
  const nextTeeTime = createPerTeeTimeAllocator('10:00');
  const groupIds = [];
  for (let g = 0; g < groupCount; g += 1) {
    const { startingHole, teeLocation } = splitStartMeta(g);
    const ids = await db('ambrose_groups').insert({
      event_id: eventId,
      day: 1,
      group_number: g + 1,
      tee_time: nextTeeTime(startingHole),
      tee_location: teeLocation,
      starting_hole: startingHole
    });
    groupIds.push(Number(Array.isArray(ids) ? ids[0] : ids));
  }

  let teamCounter = 0;
  for (let i = 0; i < teamBuckets.length; i += 1) {
    const members = teamBuckets[i];
    const groupId = groupIds[Math.floor(i / 2)];
    const lastNames = members.map((m) => String(m.last_name || `P${m.id}`)).join('/');
    const ids = await db('teams').insert({
      event_id: eventId,
      day: 1,
      competition_type: 'ambrose',
      name: lastNames,
      ambrose_group_id: groupId
    });
    const teamId = Number(Array.isArray(ids) ? ids[0] : ids);
    teamCounter += 1;
    for (const member of members) {
      await db('team_members').insert({
        team_id: teamId,
        user_id: Number(member.id),
        is_dual_assigned: false
      });
    }
  }
  return { groups: groupCount, teams: teamCounter };
}

async function getHoleRowsForDay(db, eventId, day) {
  const dayStatus = await getOrCreateDayStatus(db, eventId, day);
  const holes = await db('holes')
    .where({ course_id: dayStatus.course_id })
    .orderBy('hole_number', 'asc')
    .select('hole_number', 'par', 'stroke_index_primary', 'stroke_index_secondary');
  if (holes.length !== 18) throw new Error(`${dayLabel(day)} does not have a full 18-hole course setup`);
  return holes.map((h) => ({
    holeNumber: Number(h.hole_number),
    par: Number(h.par),
    siPrimary: Number(h.stroke_index_primary),
    siSecondary: Number(h.stroke_index_secondary)
  }));
}

async function seedDay1Scores(db, eventId) {
  const holes = await getHoleRowsForDay(db, eventId, 1);
  const teams = await db('teams')
    .where({ event_id: eventId, day: 1, competition_type: 'ambrose' })
    .orderBy('id', 'asc')
    .select('id', 'name');
  let created = 0;
  for (let tIdx = 0; tIdx < teams.length; tIdx += 1) {
    const team = teams[tIdx];
    const members = await db('team_members as tm')
      .leftJoin('player_handicaps as ph', function joinPh() {
        this.on('ph.user_id', '=', 'tm.user_id').andOnVal('ph.event_id', '=', eventId);
      })
      .where({ 'tm.team_id': team.id })
      .orderBy('tm.user_id', 'asc')
      .select('tm.user_id', 'ph.playing_handicap');
    const teamHcp = toWholeShots(
      members.reduce((sum, m) => sum + Number(m.playing_handicap || 0), 0) * ambroseAllowance(members.length)
    );

    let scorecard = await db('scorecards')
      .where({ event_id: eventId, day: 1, type: 'team', team_id: team.id })
      .first();
    if (!scorecard) {
      const ids = await db('scorecards').insert({
        event_id: eventId,
        day: 1,
        type: 'team',
        team_id: team.id,
        status: 'draft'
      });
      scorecard = await db('scorecards').where({ id: Number(Array.isArray(ids) ? ids[0] : ids) }).first();
    }

    await db('ambrose_drives').where({ scorecard_id: scorecard.id }).del();
    await db('scorecard_holes').where({ scorecard_id: scorecard.id }).del();

    for (const hole of holes) {
      const gross = Math.max(2, hole.par + (((tIdx + hole.holeNumber) % 5) - 2));
      const calc = stablefordPoints({
        grossScore: gross,
        par: hole.par,
        strokeIndexPrimary: hole.siPrimary,
        strokeIndexSecondary: hole.siSecondary,
        playingHandicap: teamHcp
      });
      await db('scorecard_holes').insert({
        scorecard_id: scorecard.id,
        hole_number: hole.holeNumber,
        gross_score: gross,
        stableford_points: calc.points,
        owner_user_id: TEST_DATA_OWNER_USER_ID
      });
      if (members.length) {
        const driveUserId = Number(members[(hole.holeNumber - 1) % members.length].user_id);
        await db('ambrose_drives').insert({
          scorecard_id: scorecard.id,
          hole_number: hole.holeNumber,
          drive_taken_user_id: driveUserId
        });
      }
    }
    await db('scorecards').where({ id: scorecard.id }).update({ status: 'submitted', updated_at: db.fn.now() });
    created += 1;
  }
  await db('event_day_statuses')
    .where({ event_id: eventId, day: 1 })
    .update({ status: 'open_scoring', updated_at: db.fn.now() });
  await markLeaderboardDirty(db, eventId);
  return created;
}

async function ensureDayGroupsForScores(db, eventId, day, playerIds) {
  const existing = await db('tee_groups').where({ event_id: eventId, day }).count({ total: '*' }).first();
  if (Number(existing?.total || 0) > 0) return;
  await createIndividualGroups(db, eventId, day, playerIds);
}

async function seedIndividualDayScores(db, eventId, day, players) {
  const holes = await getHoleRowsForDay(db, eventId, day);
  const playerIds = players.map((p) => Number(p.id));
  await ensureDayGroupsForScores(db, eventId, day, playerIds);

  const groups = await db('tee_groups as tg')
    .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
    .where({ 'tg.event_id': eventId, 'tg.day': day })
    .select('tgp.user_id')
    .groupBy('tgp.user_id');
  const usersInGroups = groups.map((r) => Number(r.user_id));

  const hcpRows = await db('player_handicaps')
    .where({ event_id: eventId })
    .whereIn('user_id', usersInGroups)
    .select('user_id', 'playing_handicap');
  const hcpByUser = new Map(hcpRows.map((h) => [Number(h.user_id), Math.trunc(Number(h.playing_handicap || 0))]));
  const orderByUser = new Map(players.map((p, idx) => [Number(p.id), idx]));
  let holeInOneSeeded = false;

  let created = 0;
  for (const userId of usersInGroups) {
    let scorecard = await db('scorecards')
      .where({ event_id: eventId, day, type: 'individual', user_id: userId })
      .first();
    if (!scorecard) {
      const ids = await db('scorecards').insert({
        event_id: eventId,
        day,
        type: 'individual',
        user_id: userId,
        status: 'draft'
      });
      scorecard = await db('scorecards').where({ id: Number(Array.isArray(ids) ? ids[0] : ids) }).first();
    }
    await db('scorecard_holes').where({ scorecard_id: scorecard.id }).del();
    const pIdx = Number(orderByUser.get(userId) || 0);
    const hcp = Number(hcpByUser.get(userId) || 0);
    for (const hole of holes) {
      const baseline = stablefordPoints({
        grossScore: hole.par,
        par: hole.par,
        strokeIndexPrimary: hole.siPrimary,
        strokeIndexSecondary: hole.siSecondary,
        playingHandicap: hcp
      });
      const baseDelta = seededStablefordDelta(seededRoll(eventId, day, userId, hole.holeNumber, pIdx));
      // Do not apply a fixed per-player round bias across all 18 holes;
      // it creates unrealistic 50-60+ point rounds.
      const gross = Math.max(1, hole.par + Number(baseline.shots || 0) + baseDelta);
      const adjustedGross = gross === 1 && holeInOneSeeded ? 2 : gross;
      if (adjustedGross === 1) holeInOneSeeded = true;
      const calc = stablefordPoints({
        grossScore: adjustedGross,
        par: hole.par,
        strokeIndexPrimary: hole.siPrimary,
        strokeIndexSecondary: hole.siSecondary,
        playingHandicap: hcp
      });
      await db('scorecard_holes').insert({
        scorecard_id: scorecard.id,
        hole_number: hole.holeNumber,
        gross_score: adjustedGross,
        stableford_points: calc.points,
        owner_user_id: TEST_DATA_OWNER_USER_ID
      });
    }
    await db('scorecards').where({ id: scorecard.id }).update({ status: 'submitted', updated_at: db.fn.now() });
    created += 1;
  }

  await db('event_day_statuses')
    .where({ event_id: eventId, day })
    .update({ status: 'open_scoring', updated_at: db.fn.now() });
  await markLeaderboardDirty(db, eventId);
  return created;
}

async function seedCalcuttaDetails(db, eventId, playerIds) {
  const ids = [...new Set((playerIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return 0;

  const drawOrder = shuffleArray(ids);
  await db('calcutta_auctions').where({ event_id: eventId }).del();

  const buyerPool = ids.length > 1 ? ids : [ids[0]];
  for (let idx = 0; idx < drawOrder.length; idx += 1) {
    const auctionedUserId = Number(drawOrder[idx]);
    const buyerUserId = buyerPool[Math.floor(Math.random() * buyerPool.length)];
    const ownerUserId = ids[Math.floor(Math.random() * ids.length)];
    const soldPrice = 50 + Math.floor(Math.random() * 251); // 50..300

    await db('calcutta_auctions').insert({
      event_id: eventId,
      auctioned_user_id: auctionedUserId,
      buyer_user_id: Number(buyerUserId),
      owner_user_id: Number(ownerUserId),
      auction_bid_amount: Number(soldPrice),
      draw_order: idx + 1
    });
  }
  return drawOrder.length;
}

async function purgeTestEventData(db, eventId) {
  // Intentionally preserve event-level configuration (prize config, event metadata)
  // and day/course setup; purge only generated test scoring/entry data.
  const seedUsers = await listSeedUsers(db);
  const seedUserIds = seedUsers.map((u) => Number(u.id));

  const scorecardIds = await db('scorecards').where({ event_id: eventId }).pluck('id');
  if (scorecardIds.length) {
    await db('ambrose_drives').whereIn('scorecard_id', scorecardIds).del();
    await db('scorecard_holes').whereIn('scorecard_id', scorecardIds).del();
  }
  await db('scorecards').where({ event_id: eventId }).del();

  await db('team_members')
    .whereIn('team_id', db('teams').where({ event_id: eventId }).select('id'))
    .del();
  await db('teams').where({ event_id: eventId }).del();
  await db('ambrose_groups').where({ event_id: eventId }).del();
  await db('tee_groups').where({ event_id: eventId }).del();
  await db('calcutta_auctions').where({ event_id: eventId }).del();
  await db('novelty_results').where({ event_id: eventId }).del();
  await db('skins_carry').where({ event_id: eventId }).del();
  await db('skins_holes').where({ event_id: eventId }).del();
  await db('leaderboard_snapshots').where({ event_id: eventId }).del();
  await db('player_handicaps').where({ event_id: eventId }).del();
  await db('event_players').where({ event_id: eventId }).del();

  await db('event_day_statuses')
    .where({ event_id: eventId })
    .update({ status: 'draft', leaderboard_published: 0, updated_at: db.fn.now() });

  if (seedUserIds.length) {
    await db('users').whereIn('id', seedUserIds).del();
  }
  await markLeaderboardDirty(db, eventId);
}

function redirectWithError(res, message) {
  return res.redirect(`/admin/dashboard?error=${encodeURIComponent(message)}`);
}

function redirectWithMessage(res, message) {
  return res.redirect(`/admin/dashboard?message=${encodeURIComponent(message)}`);
}

function parseCheckbox(value) {
  return value === 'on' ? 1 : 0;
}

function parseNonNegativeMoney(value, fallback = 0) {
  const raw = String(value ?? '').trim();
  if (!raw) return Number(fallback);
  const num = Number(raw);
  if (!Number.isFinite(num)) return Number(fallback);
  return Math.max(0, num);
}

function parseNonNegativePercent(value, fallback = 0) {
  const raw = String(value ?? '').trim();
  if (!raw) return Number(fallback);
  const num = Number(raw);
  if (!Number.isFinite(num)) return Number(fallback);
  return Math.max(0, num);
}

function normalizeNullablePositiveInt(value) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return null;
  return num;
}

function formatOrdinal(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return String(value || '');
  const mod100 = n % 100;
  const mod10 = n % 10;
  let suffix = 'th';
  if (mod100 < 11 || mod100 > 13) {
    if (mod10 === 1) suffix = 'st';
    else if (mod10 === 2) suffix = 'nd';
    else if (mod10 === 3) suffix = 'rd';
  }
  return `${n}${suffix}`;
}

function parseDay(value, fallback = 1) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 4) return fallback;
  return day;
}

function parseIndividualDay(value, fallback = 2) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 2 || day > 4) return fallback;
  return day;
}

function normalizeNoveltyType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'ntp') return NOVELTY_TYPES.NTP;
  if (raw === 'long drive' || raw === 'long_drive' || raw === 'long-drive') return NOVELTY_TYPES.LONG_DRIVE;
  return null;
}

function defaultNoveltyLabel(type) {
  const normalized = normalizeNoveltyType(type);
  return normalized || NOVELTY_TYPES.NTP;
}

function formatHandicapDisplay(raw) {
  if (raw === null || raw === undefined || raw === '') return '-';
  const num = Number(raw);
  if (!Number.isFinite(num)) return '-';
  const abs = Number.isInteger(num) ? String(Math.abs(num)) : String(Math.abs(num).toFixed(1)).replace(/\\.0$/, '');
  return num < 0 ? `+${abs}` : abs;
}

function formatTeeLocationFromStartingHole(startingHole) {
  const hole = Number(startingHole);
  if (!Number.isInteger(hole) || hole < 1 || hole > 18) return '';
  const mod100 = hole % 100;
  const mod10 = hole % 10;
  let suffix = 'th';
  if (mod100 < 11 || mod100 > 13) {
    if (mod10 === 1) suffix = 'st';
    else if (mod10 === 2) suffix = 'nd';
    else if (mod10 === 3) suffix = 'rd';
  }
  return `${hole}${suffix} tee`;
}

function parseTimeToMinutes(raw) {
  const input = String(raw || '').trim();
  const match = /^(\d{1,2}):(\d{2})/.exec(input);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function minutesToTime(totalMinutes) {
  const normalized = ((Number(totalMinutes) % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function addMinutesToTime(raw, deltaMinutes) {
  const base = parseTimeToMinutes(raw);
  const safeBase = base === null ? parseTimeToMinutes('07:00') : base;
  return minutesToTime(safeBase + Number(deltaMinutes || 0));
}

function sanitizeAdminReturnTo(eventId, raw, fallback) {
  const candidate = String(raw || '').trim();
  if (!candidate) return fallback;
  if (!candidate.startsWith(`/admin/events/${eventId}/`)) return fallback;
  return candidate;
}

function summarizeHoleTotals(holes) {
  const valid = (holes || []).filter((h) => h.gross != null);
  const sum = (arr, key) => arr.reduce((acc, row) => acc + Number(row[key] || 0), 0);
  const front = valid.filter((h) => h.holeNumber <= 9);
  const back = valid.filter((h) => h.holeNumber >= 10);
  return {
    grossFront: sum(front, 'gross'),
    grossBack: sum(back, 'gross'),
    grossTotal: sum(valid, 'gross'),
    netFront: sum(front, 'net'),
    netBack: sum(back, 'net'),
    netTotal: sum(valid, 'net'),
    stablefordFront: sum(front, 'stableford'),
    stablefordBack: sum(back, 'stableford'),
    stablefordTotal: sum(valid, 'stableford')
  };
}

async function getCourseHolesForEventDay(db, eventId, day) {
  return db('event_day_statuses as eds')
    .join('holes as h', 'h.course_id', 'eds.course_id')
    .where({ 'eds.event_id': eventId, 'eds.day': day })
    .orderBy('h.hole_number', 'asc')
    .select('h.hole_number', 'h.par', 'h.stroke_index_primary', 'h.stroke_index_secondary');
}

async function getHoleConfigForEventDay(db, eventId, day, holeNumber) {
  return db('event_day_statuses as eds')
    .join('holes as h', 'h.course_id', 'eds.course_id')
    .where({ 'eds.event_id': eventId, 'eds.day': day, 'h.hole_number': holeNumber })
    .select('h.hole_number', 'h.par', 'h.stroke_index_primary', 'h.stroke_index_secondary')
    .first();
}

async function getTeamHandicapInfo(db, eventId, teamId) {
  const members = await db('team_members as tm')
    .leftJoin('player_handicaps as ph', function joinPh() {
      this.on('ph.user_id', '=', 'tm.user_id').andOnVal('ph.event_id', '=', eventId);
    })
    .where({ 'tm.team_id': teamId })
    .select('ph.playing_handicap');
  const allowance = ambroseAllowance(members.length);
  const raw = members.reduce((sum, m) => sum + Number(m.playing_handicap || 0), 0) * allowance;
  return {
    raw,
    wholeShots: toWholeShots(raw)
  };
}

function formatNumberTrimmed(raw, maxDp = 2) {
  if (raw === null || raw === undefined) return '0';
  const num = Number(raw);
  if (!Number.isFinite(num)) return '0';
  return num.toFixed(maxDp).replace(/\.?0+$/, '');
}

function formatAmbroseExactHandicap(raw, allowance) {
  const num = Number(raw || 0);
  if (!Number.isFinite(num)) return '0';
  const sign = num < 0 ? '+' : '';
  const abs = Math.abs(num);
  let whole = Math.trunc(abs);
  const fraction = abs - whole;

  let denominator = 1;
  if (allowance === 1 / 4) denominator = 4;
  if (allowance === 1 / 3) denominator = 3;
  if (denominator === 1) return `${sign}${whole}`;

  let numerator = Math.round(fraction * denominator);
  if (numerator >= denominator) {
    whole += 1;
    numerator = 0;
  }

  if (numerator > 0) {
    const gcd = (a, b) => {
      let x = Math.abs(a);
      let y = Math.abs(b);
      while (y) {
        const t = y;
        y = x % y;
        x = t;
      }
      return x || 1;
    };
    const factor = gcd(numerator, denominator);
    numerator /= factor;
    denominator /= factor;
  }

  if (!numerator) return `${sign}${whole}`;
  return `${sign}${whole} ${numerator}/${denominator}`;
}

function buildIndividualResultText(calcType, totals) {
  if (String(calcType || '') === CALC_TYPES.STABLEFORD) {
    return `${Number(totals.stablefordTotal || 0)} pts`;
  }
  return `${Number(totals.grossTotal || 0)} gross / ${Number(totals.netTotal || 0)} net`;
}

function buildTeamResultText(totals, exactTeamHandicap) {
  const gross = Number(totals.grossTotal || 0);
  const net = gross - Number(exactTeamHandicap || 0);
  return `${gross} gross / ${formatNumberTrimmed(net)} net`;
}

async function buildIndividualAdminScorecardModel(db, event, scorecard) {
  const day = Number(scorecard.day);
  const [dayStatus, user, handicap, holeConfig, holeScores] = await Promise.all([
    getOrCreateDayStatus(db, event.id, day),
    db('users').where({ id: scorecard.user_id }).first(),
    db('player_handicaps').where({ event_id: event.id, user_id: scorecard.user_id }).first(),
    getCourseHolesForEventDay(db, event.id, day),
    db('scorecard_holes').where({ scorecard_id: scorecard.id }).select('hole_number', 'gross_score', 'stableford_points')
  ]);
  if (!user || !holeConfig.length) return null;

  const playingHandicap = Math.trunc(Number(handicap?.playing_handicap || 0));
  const byHole = new Map(holeScores.map((row) => [Number(row.hole_number), row]));
  const holes = holeConfig.map((hole) => {
    const saved = byHole.get(Number(hole.hole_number));
    const gross = saved ? Number(saved.gross_score) : null;
    const shots = strokesForHole(
      playingHandicap,
      Number(hole.stroke_index_primary || 0),
      Number(hole.stroke_index_secondary || 0)
    );
    return {
      holeNumber: Number(hole.hole_number),
      par: Number(hole.par || 0),
      siPrimary: Number(hole.stroke_index_primary || 0),
      gross,
      net: gross == null ? null : gross - shots,
      stableford: saved && saved.stableford_points != null ? Number(saved.stableford_points) : null
    };
  });

  const calcType = String(dayStatus?.calc_type || defaultCalcTypeForDay(day));
  const totals = summarizeHoleTotals(holes);
  const front9 = holes.filter((h) => Number(h.holeNumber) >= 1 && Number(h.holeNumber) <= 9);
  const back9 = holes.filter((h) => Number(h.holeNumber) >= 10 && Number(h.holeNumber) <= 18);
  return {
    id: Number(scorecard.id),
    mode: 'individual',
    day,
    roundLabel: dayLabel(day),
    dayLabel: dayLabel(day),
    calcType,
    showStablefordTotals: calcType === CALC_TYPES.STABLEFORD,
    showGrossOnlyTotals: calcType !== CALC_TYPES.STABLEFORD,
    title: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
    subtitle: `Hcp ${playingHandicap}`,
    resultLabel: buildIndividualResultText(calcType, totals),
    totals,
    holes,
    front9,
    back9,
    canEdit: Number(dayStatus?.leaderboard_published || 0) !== 1
  };
}

async function buildTeamAdminScorecardModel(db, event, scorecard) {
  const day = Number(scorecard.day);
  const [dayStatus, team, memberRows, holeConfig, holeScores, teamHandicap] = await Promise.all([
    getOrCreateDayStatus(db, event.id, day),
    db('teams').where({ id: scorecard.team_id, event_id: event.id }).first(),
    db('team_members as tm')
      .join('users as u', 'u.id', 'tm.user_id')
      .leftJoin('player_handicaps as ph', function joinPh() {
        this.on('ph.user_id', '=', 'tm.user_id').andOnVal('ph.event_id', '=', event.id);
      })
      .where({ 'tm.team_id': scorecard.team_id })
      .select('u.first_name', 'u.last_name', 'ph.playing_handicap'),
    getCourseHolesForEventDay(db, event.id, day),
    db('scorecard_holes').where({ scorecard_id: scorecard.id }).select('hole_number', 'gross_score', 'stableford_points'),
    getTeamHandicapInfo(db, event.id, scorecard.team_id)
  ]);
  if (!team || !holeConfig.length) return null;

  const byHole = new Map(holeScores.map((row) => [Number(row.hole_number), row]));
  const holes = holeConfig.map((hole) => {
    const saved = byHole.get(Number(hole.hole_number));
    const gross = saved ? Number(saved.gross_score) : null;
    const shots = strokesForHole(
      Number(teamHandicap.wholeShots || 0),
      Number(hole.stroke_index_primary || 0),
      Number(hole.stroke_index_secondary || 0)
    );
    return {
      holeNumber: Number(hole.hole_number),
      par: Number(hole.par || 0),
      siPrimary: Number(hole.stroke_index_primary || 0),
      gross,
      net: gross == null ? null : gross - shots,
      stableford: saved && saved.stableford_points != null ? Number(saved.stableford_points) : null
    };
  });

  const totals = summarizeHoleTotals(holes);
  const front9 = holes.filter((h) => Number(h.holeNumber) >= 1 && Number(h.holeNumber) <= 9);
  const back9 = holes.filter((h) => Number(h.holeNumber) >= 10 && Number(h.holeNumber) <= 18);
  const membersLabel = memberRows.map((m) => `${m.first_name || ''} ${m.last_name || ''}`.trim()).filter(Boolean).join(', ');
  return {
    id: Number(scorecard.id),
    mode: 'team',
    day,
    roundLabel: dayLabel(day),
    dayLabel: dayLabel(day),
    calcType: String(dayStatus?.calc_type || defaultCalcTypeForDay(day)),
    showStablefordTotals: false,
    showGrossOnlyTotals: true,
    title: team.name || 'Team',
    subtitle: membersLabel || null,
    resultLabel: buildTeamResultText(totals, teamHandicap.raw),
    totals,
    holes,
    front9,
    back9,
    canEdit: Number(dayStatus?.leaderboard_published || 0) !== 1
  };
}

async function getIndividualScoreSummariesForDay(db, eventId, day, userIds) {
  const ids = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const rows = await db('scorecards as s')
    .leftJoin('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .where({ 's.event_id': eventId, 's.day': day, 's.type': 'individual' })
    .whereIn('s.user_id', ids)
    .groupBy('s.id', 's.user_id', 's.status')
    .select('s.id', 's.user_id', 's.status')
    .count({ holes_count: 'sh.id' })
    .sum({ gross_total: 'sh.gross_score', stableford_total: 'sh.stableford_points' });
  const out = new Map();
  rows.forEach((row) => {
    out.set(Number(row.user_id), {
      scorecardId: Number(row.id),
      status: String(row.status || 'draft'),
      holesCount: Number(row.holes_count || 0),
      grossTotal: Number(row.gross_total || 0),
      stablefordTotal: Number(row.stableford_total || 0)
    });
  });
  return out;
}

async function getTeamScoreSummariesForDay(db, eventId, day, teamIds) {
  const ids = [...new Set((teamIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const [rows, handicaps] = await Promise.all([
    db('scorecards as s')
      .leftJoin('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
      .where({ 's.event_id': eventId, 's.day': day, 's.type': 'team' })
      .whereIn('s.team_id', ids)
      .groupBy('s.id', 's.team_id', 's.status')
      .select('s.id', 's.team_id', 's.status')
      .count({ holes_count: 'sh.id' })
      .sum({ gross_total: 'sh.gross_score', stableford_total: 'sh.stableford_points' }),
    db('team_members as tm')
      .leftJoin('player_handicaps as ph', function joinPh() {
        this.on('ph.user_id', '=', 'tm.user_id').andOnVal('ph.event_id', '=', eventId);
      })
      .whereIn('tm.team_id', ids)
      .groupBy('tm.team_id')
      .select('tm.team_id')
      .count({ member_count: 'tm.user_id' })
      .sum({ hcp_sum: 'ph.playing_handicap' })
  ]);
  const handicapByTeam = new Map();
  handicaps.forEach((row) => {
    const count = Number(row.member_count || 0);
    const allowance = ambroseAllowance(count);
    handicapByTeam.set(Number(row.team_id), Number(row.hcp_sum || 0) * allowance);
  });

  const out = new Map();
  rows.forEach((row) => {
    const teamId = Number(row.team_id);
    const grossTotal = Number(row.gross_total || 0);
    const exactHandicap = Number(handicapByTeam.get(teamId) || 0);
    out.set(teamId, {
      scorecardId: Number(row.id),
      status: String(row.status || 'draft'),
      holesCount: Number(row.holes_count || 0),
      grossTotal,
      stablefordTotal: Number(row.stableford_total || 0),
      exactHandicap,
      netExact: grossTotal - exactHandicap
    });
  });
  return out;
}

async function getScorecardEditLogs(db, scorecardId) {
  return db('scorecard_edit_logs as sel')
    .leftJoin('users as u', 'u.id', 'sel.editor_user_id')
    .where({ 'sel.scorecard_id': scorecardId })
    .orderBy([{ column: 'sel.created_at', order: 'desc' }, { column: 'sel.id', order: 'desc' }])
    .select(
      'sel.id',
      'sel.hole_number',
      'sel.previous_gross_score',
      'sel.previous_stableford_points',
      'sel.new_gross_score',
      'sel.new_stableford_points',
      'sel.created_at',
      'u.first_name',
      'u.last_name'
    );
}

async function normalizeTeeGroupsForDay(db, eventId, day) {
  const rows = await db('tee_groups')
    .where({ event_id: eventId, day })
    .orderBy([{ column: 'tee_time', order: 'asc' }, { column: 'starting_hole', order: 'asc' }, { column: 'id', order: 'asc' }])
    .select('id');
  for (let i = 0; i < rows.length; i += 1) {
    await db('tee_groups')
      .where({ id: Number(rows[i].id) })
      .update({ group_number: i + 1, updated_at: db.fn.now() });
  }
}

function day4GroupSizes(playerCount) {
  const total = Number(playerCount || 0);
  if (total <= 0) return [];
  const remainder = total % 4;
  const sizes = [];

  if (remainder === 3) {
    sizes.push(3);
  } else if (remainder === 2) {
    sizes.push(3, 3);
  } else if (remainder === 1) {
    // Avoid 2-balls and keep leading groups (highest leaderboard, last groups) at 4.
    sizes.push(3, 3, 3);
  }

  const consumed = sizes.reduce((sum, n) => sum + n, 0);
  const remaining = total - consumed;
  const groupsOfFour = Math.floor(remaining / 4);
  for (let i = 0; i < groupsOfFour; i += 1) sizes.push(4);

  return sizes;
}

async function isGlobalCourseEditingLocked(db, courseId) {
  const row = await db('event_day_statuses as eds')
    .join('events as e', 'e.id', 'eds.event_id')
    .join('scorecards as s', function joinScorecards() {
      this.on('s.event_id', '=', 'eds.event_id').andOn('s.day', '=', 'eds.day');
    })
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .where({ 'eds.course_id': courseId, 'e.is_active': 1 })
    .count({ total: 'sh.id' })
    .first();

  return Number(row?.total || 0) > 0;
}

async function getOrCreateDayStatus(db, eventId, day) {
  let row = await db('event_day_statuses').where({ event_id: eventId, day }).first();
  if (!row) {
    const defaultCourse = await db('courses').orderBy('id', 'asc').first();
    if (!defaultCourse) throw new Error('No courses configured');
    await db('event_day_statuses').insert({
      event_id: eventId,
      day,
      status: 'draft',
      calc_type: defaultCalcTypeForDay(day),
      leaderboard_published: 0,
      course_id: Number(defaultCourse.id)
    });
    row = await db('event_day_statuses').where({ event_id: eventId, day }).first();
  } else if (!row.calc_type) {
    await db('event_day_statuses')
      .where({ id: row.id })
      .update({ calc_type: defaultCalcTypeForDay(day), updated_at: db.fn.now() });
    row = await db('event_day_statuses').where({ id: row.id }).first();
  }
  return row;
}

async function ensureDayScorecards(db, eventId, day) {
  // Individual scorecards for players assigned to tee groups on this day.
  const playersInGroups = await db('tee_groups as tg')
    .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
    .where({ 'tg.event_id': eventId, 'tg.day': day })
    .distinct('tgp.user_id');

  for (const row of playersInGroups) {
    const userId = Number(row.user_id);
    const existing = await db('scorecards')
      .where({ event_id: eventId, day, type: 'individual', user_id: userId })
      .first();
    if (!existing) {
      await db('scorecards').insert({
        event_id: eventId,
        day,
        type: 'individual',
        user_id: userId,
        status: 'draft'
      });
    }
  }

  const dayStatus = await getOrCreateDayStatus(db, eventId, day);
  // Ambrose team scorecards.
  if (String(dayStatus.calc_type || '') === CALC_TYPES.AMBROSE_NETT) {
    const teams = await db('teams')
      .where({ event_id: eventId, day, competition_type: 'ambrose' })
      .select('id');

    for (const team of teams) {
      const existing = await db('scorecards')
        .where({ event_id: eventId, day, type: 'team', team_id: team.id })
        .first();
      if (!existing) {
        await db('scorecards').insert({
          event_id: eventId,
          day,
          type: 'team',
          team_id: team.id,
          status: 'draft'
        });
      }
    }
  }
}

async function countRecordedScoresForDay(db, eventId, day) {
  const row = await db('scorecards as s')
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .where({ 's.event_id': eventId, 's.day': day })
    .count({ total: 'sh.id' })
    .first();
  return Number(row?.total || 0);
}

async function hasRecordedScoresForEvent(db, eventId) {
  const row = await db('scorecards as s')
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .where({ 's.event_id': eventId })
    .where('sh.gross_score', '>', 0)
    .count({ total: 'sh.id' })
    .first();
  return Number(row?.total || 0) > 0;
}

async function getDayFinalizationSummary(db, eventId, day) {
  const row = await db('scorecards')
    .where({ event_id: eventId, day })
    .count({ total: '*' })
    .sum({
      submitted: db.raw(`CASE WHEN status = 'submitted' THEN 1 ELSE 0 END`)
    })
    .first();

  const total = Number(row?.total || 0);
  const submitted = Number(row?.submitted || 0);
  return {
    total,
    submitted,
    isFinalized: total > 0 && submitted === total
  };
}

async function getFinalizedDays(db, eventId) {
  const rows = await db('scorecards')
    .where({ event_id: eventId })
    .whereIn('day', [1, 2, 3, 4])
    .groupBy('day')
    .select('day')
    .count({ total: '*' })
    .sum({
      submitted: db.raw(`CASE WHEN status = 'submitted' THEN 1 ELSE 0 END`)
    });

  return rows
    .map((row) => ({
      day: Number(row.day),
      total: Number(row.total || 0),
      submitted: Number(row.submitted || 0)
    }))
    .filter((row) => row.total > 0 && row.total === row.submitted)
    .map((row) => row.day)
    .sort((a, b) => a - b);
}

async function getNoveltyEventsForEvent(db, eventId) {
  const rows = await db('novelty_events')
    .where({ event_id: eventId })
    .orderBy([{ column: 'day', order: 'asc' }, { column: 'hole_number', order: 'asc' }, { column: 'id', order: 'asc' }])
    .select('id', 'day', 'course_id', 'hole_number', 'novelty_type', 'label');
  const byDay = new Map();
  rows.forEach((row) => {
    const day = Number(row.day);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({
      id: Number(row.id),
      day,
      courseId: Number(row.course_id || 0),
      holeNumber: Number(row.hole_number || 0),
      noveltyType: String(row.novelty_type || ''),
      label: String(row.label || '').trim() || defaultNoveltyLabel(row.novelty_type)
    });
  });
  return byDay;
}

async function getNoveltyEventsForDayWithResults(db, eventId, day) {
  const rows = await db('novelty_events as ne')
    .leftJoin('novelty_results as nr', 'nr.novelty_event_id', 'ne.id')
    .leftJoin('users as u', 'u.id', 'nr.winner_user_id')
    .leftJoin('teams as t', 't.id', 'nr.winner_team_id')
    .where({ 'ne.event_id': eventId, 'ne.day': day })
    .orderBy([{ column: 'ne.hole_number', order: 'asc' }, { column: 'ne.id', order: 'asc' }])
    .select(
      'ne.id',
      'ne.hole_number',
      'ne.novelty_type',
      'ne.label',
      'nr.id as result_id',
      'nr.winner_user_id',
      'nr.winner_team_id',
      'nr.is_no_winner',
      'u.first_name',
      'u.last_name',
      't.name as team_name'
    );

  return rows.map((row) => {
    const winnerUserId = row.winner_user_id == null ? null : Number(row.winner_user_id);
    const winnerTeamId = row.winner_team_id == null ? null : Number(row.winner_team_id);
    const winnerName = winnerTeamId
      ? String(row.team_name || '').trim()
      : `${row.first_name || ''} ${row.last_name || ''}`.trim();
    return {
      id: Number(row.id),
      holeNumber: Number(row.hole_number || 0),
      noveltyType: String(row.novelty_type || ''),
      label: String(row.label || '').trim() || defaultNoveltyLabel(row.novelty_type),
      resultId: row.result_id == null ? null : Number(row.result_id),
      winnerUserId,
      winnerTeamId,
      isNoWinner: Number(row.is_no_winner || 0) === 1,
      winnerName: winnerName || null
    };
  });
}

async function getNoveltySelectionOptionsForDay(db, eventId, day) {
  if (Number(day) === 1) {
    const rows = await db('teams as t')
      .join('team_members as tm', 'tm.team_id', 't.id')
      .join('users as u', 'u.id', 'tm.user_id')
      .where({ 't.event_id': eventId, 't.day': 1, 't.competition_type': 'ambrose' })
      .orderBy([{ column: 'u.last_name', order: 'asc' }, { column: 'u.first_name', order: 'asc' }])
      .distinct('u.id', 'u.first_name', 'u.last_name');
    return rows.map((row) => ({
      value: `user:${Number(row.id)}`,
      label: `${row.first_name || ''} ${row.last_name || ''}`.trim()
    }));
  }

  const rows = await db('tee_groups as tg')
    .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
    .join('users as u', 'u.id', 'tgp.user_id')
    .where({ 'tg.event_id': eventId, 'tg.day': day })
    .orderBy([{ column: 'u.last_name', order: 'asc' }, { column: 'u.first_name', order: 'asc' }])
    .distinct('u.id', 'u.first_name', 'u.last_name');
  return rows.map((row) => ({
    value: `user:${Number(row.id)}`,
    label: `${row.first_name || ''} ${row.last_name || ''}`.trim()
  }));
}

async function upsertNoveltyResult(db, eventId, day, noveltyId, selection) {
  const novelty = await db('novelty_events')
    .where({ id: noveltyId, event_id: eventId, day })
    .first();
  if (!novelty) throw new Error('invalid_novelty');

  const raw = String(selection || '').trim();
  let winnerUserId = null;
  let winnerTeamId = null;
  let isNoWinner = 0;

  if (raw === 'none') {
    isNoWinner = 1;
  } else if (raw.startsWith('user:')) {
    winnerUserId = Number(raw.slice(5));
    if (!Number.isInteger(winnerUserId) || winnerUserId <= 0) throw new Error('invalid_selection');
    let userValid = null;
    if (Number(day) === 1) {
      userValid = await db('teams as t')
        .join('team_members as tm', 'tm.team_id', 't.id')
        .where({
          't.event_id': eventId,
          't.day': 1,
          't.competition_type': 'ambrose',
          'tm.user_id': winnerUserId
        })
        .first('tm.user_id');
    } else {
      userValid = await db('tee_groups as tg')
        .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
        .where({ 'tg.event_id': eventId, 'tg.day': day, 'tgp.user_id': winnerUserId })
        .first('tgp.user_id');
    }
    if (!userValid) throw new Error('invalid_selection');
  } else {
    throw new Error('invalid_selection');
  }

  const existing = await db('novelty_results').where({ novelty_event_id: noveltyId }).first();
  const payload = {
    event_id: eventId,
    day,
    novelty_event_id: noveltyId,
    winner_user_id: winnerUserId,
    winner_team_id: winnerTeamId,
    is_no_winner: isNoWinner,
    updated_at: db.fn.now()
  };
  if (existing) {
    await db('novelty_results').where({ id: existing.id }).update(payload);
  } else {
    await db('novelty_results').insert({
      ...payload,
      created_at: db.fn.now()
    });
  }
}

function adminRouter(db) {
  const router = express.Router();

  router.get('/events/:id/presentation-sheet', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const day = parseDay(req.query.day, 1);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');
      const dayStatus = await getOrCreateDayStatus(db, eventId, day);
      const isAmbroseDay = String(dayStatus.calc_type || '') === CALC_TYPES.AMBROSE_NETT;

      const dayFinalization = await getDayFinalizationSummary(db, eventId, day);
      if (!dayFinalization.isFinalized) {
        const base = day === 1 ? `/admin/events/${eventId}/ambrose` : `/admin/events/${eventId}/tee-times?day=${day}`;
        return res.redirect(`${base}${base.includes('?') ? '&' : '?'}error=Day%20is%20not%20fully%20submitted`);
      }

      const finalizedDays = await getFinalizedDays(db, eventId);
      const [ambrose, stableford, skins, eclectic, sultans, noveltyResults] = await Promise.all([
        calculateAmbroseLeaderboard(db, eventId),
        calculateStablefordLeaderboards(db, eventId),
        calculateEventSkinsForDays(db, eventId, finalizedDays),
        day === 4 ? calculateEclecticLeaderboard(db, eventId) : Promise.resolve([]),
        day === 4 ? calculateSultansLeaderboard(db, eventId) : Promise.resolve([]),
        getNoveltyEventsForDayWithResults(db, eventId, day)
      ]);

      const individualTop5 = isAmbroseDay
        ? []
        : (stableford?.byDay?.[day] || []).slice(0, 5).map((row) => ({
            position: Number(row.position || 0),
            name: row.name,
            points: Number(row.total || 0),
            cb9: Number(row.countbackLast9 || 0),
            cb6: Number(row.countbackLast6 || 0),
            cb3: Number(row.countbackLast3 || 0),
            cb1: Number(row.countbackLast1 || 0)
          }));
      const individualCountByPoints = new Map();
      individualTop5.forEach((row) => {
        const key = Number(row.points || 0);
        individualCountByPoints.set(key, Number(individualCountByPoints.get(key) || 0) + 1);
      });
      const individualShowCountback = individualTop5.some((row) => Number(individualCountByPoints.get(Number(row.points || 0)) || 0) > 1);
      const individualTop5WithCountback = individualTop5.map((row) => ({
        ...row,
        countbackUsed: Number(individualCountByPoints.get(Number(row.points || 0)) || 0) > 1
      }));
      const dayPointsByUser = new Map();
      [2, 3, 4].forEach((roundDay) => {
        (stableford?.byDay?.[roundDay] || []).forEach((row) => {
          const key = Number(row.userId || 0);
          if (!key) return;
          if (!dayPointsByUser.has(key)) dayPointsByUser.set(key, { d2: 0, d3: 0, d4: 0 });
          const current = dayPointsByUser.get(key);
          current[`d${roundDay}`] = Number(row.total || 0);
        });
      });

      const championshipTop5Raw = (!isAmbroseDay && [2, 3, 4].includes(day))
        ? (stableford?.championship || []).slice(0, 5).map((row) => {
            const perDay = dayPointsByUser.get(Number(row.userId || 0)) || { d2: 0, d3: 0, d4: 0 };
            return {
              position: Number(row.position || 0),
              name: row.name,
              points: Number(row.total || 0),
              d2: Number(perDay.d2 || 0),
              d3: Number(perDay.d3 || 0),
              d4: Number(perDay.d4 || 0),
              cb9: Number(row.countbackLast9 || 0),
              cb6: Number(row.countbackLast6 || 0),
              cb3: Number(row.countbackLast3 || 0),
              cb1: Number(row.countbackLast1 || 0)
            };
          })
        : [];

      const totalCountByPoints = new Map();
      championshipTop5Raw.forEach((row) => {
        const key = Number(row.points || 0);
        totalCountByPoints.set(key, Number(totalCountByPoints.get(key) || 0) + 1);
      });
      const tournamentShowCountback = day === 4 && championshipTop5Raw.some((row) => Number(totalCountByPoints.get(Number(row.points || 0)) || 0) > 1);
      const tournamentTop5 = championshipTop5Raw.map((row) => {
        const isTied = Number(totalCountByPoints.get(Number(row.points || 0)) || 0) > 1;
        return {
          ...row,
          placeDisplay: isTied ? `${row.position}=` : String(row.position),
          countbackDisplay: `${row.cb9}/${row.cb6}/${row.cb3}/${row.cb1}`,
          countbackUsed: isTied
        };
      });

      const ambroseTop5 = isAmbroseDay
        ? (ambrose || []).slice(0, 5).map((row, index) => ({
            position: Number(row.position || (index + 1)),
            name: row.name,
            gross: Number(row.totalGross || 0),
            net: Number(row.totalNet || 0)
          }))
        : [];
      const eclecticTop3 = day === 4
        ? (eclectic || []).slice(0, 3).map((row, index) => ({
            position: index + 1,
            name: row.name,
            totalPoints: Number(row.totalPoints || 0)
          }))
        : [];
      const sultansTop2 = day === 4
        ? (sultans || []).slice(0, 2).map((row, index) => ({
            position: index + 1,
            name: row.name,
            aggregate: Number(row.aggregate || 0)
          }))
        : [];

      const ambroseWinnerRow = (ambrose || [])[0] || null;
      const legendsChampionRow = day === 4 ? (tournamentTop5[0] || null) : null;
      const sultansWinnerRow = day === 4 ? (sultansTop2[0] || null) : null;
      const eclecticWinnerRow = day === 4 ? (eclecticTop3[0] || null) : null;
      const trophies = {
        ambrose: ambroseWinnerRow
          ? { name: ambroseWinnerRow.name, detail: `Net ${Number(ambroseWinnerRow.totalNet || 0)}` }
          : null,
        sultans: sultansWinnerRow
          ? { name: sultansWinnerRow.name, detail: `Aggregate ${Number(sultansWinnerRow.aggregate || 0)}` }
          : null,
        eclectic: eclecticWinnerRow
          ? { name: eclecticWinnerRow.name, detail: `${Number(eclecticWinnerRow.totalPoints || 0)} pts` }
          : null,
        legendsChampion: legendsChampionRow
          ? { name: legendsChampionRow.name, detail: `${Number(legendsChampionRow.points || 0)} pts` }
          : null
      };

      const daySkinWins = (skins?.holes || [])
        .filter((hole) => Number(hole.day) === day && hole.status === 'won' && hole.winning_participant_id && hole.winner_name)
        .map((hole) => {
          const basePot = Number(hole.base_pot_amount || 0);
          const totalPot = Number(hole.total_pot_amount || 0);
          const skinsCount = basePot > 0 ? Math.round(totalPot / basePot) : 0;
          return {
            holeNumber: Number(hole.hole_number),
            name: hole.winner_name,
            gross: hole.winning_gross == null ? null : Number(hole.winning_gross),
            stableford: hole.winning_stableford == null ? null : Number(hole.winning_stableford),
            skinsCount
          };
        })
        .sort((a, b) => a.holeNumber - b.holeNumber);

      const daySkinsSummaryMap = new Map();
      for (const win of daySkinWins) {
        const key = String(win.name || '').trim();
        if (!daySkinsSummaryMap.has(key)) daySkinsSummaryMap.set(key, { name: win.name, skinsCount: 0 });
        const current = daySkinsSummaryMap.get(key);
        current.skinsCount += Number(win.skinsCount || 0);
      }
      const daySkinsSummary = [...daySkinsSummaryMap.values()].sort((a, b) => (
        Number(b.skinsCount || 0) - Number(a.skinsCount || 0) ||
        String(a.name || '').localeCompare(String(b.name || ''))
      ));

      const hole18 = (skins?.holes || []).find((hole) => Number(hole.day) === day && Number(hole.hole_number) === 18);
      const carryToNextDay = hole18 && hole18.status !== 'won'
        ? (Number(hole18.base_pot_amount || 0) > 0
            ? Math.round(Number(hole18.total_pot_amount || 0) / Number(hole18.base_pot_amount || 0))
            : 0)
        : 0;
      const hole1 = (skins?.holes || []).find((hole) => Number(hole.day) === day && Number(hole.hole_number) === 1);
      const carryIntoDay = hole1 && Number(hole1.carry_in_amount || 0) > 0
        ? (Number(hole1.base_pot_amount || 0) > 0
            ? Math.round(Number(hole1.carry_in_amount || 0) / Number(hole1.base_pot_amount || 0))
            : 0)
        : 0;

      const dayHighlightsRow = await db('scorecards as s')
        .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
        .join('event_day_statuses as eds', function joinDayStatus() {
          this.on('eds.event_id', '=', 's.event_id').andOn('eds.day', '=', 's.day');
        })
        .join('holes as h', function joinHoles() {
          this.on('h.course_id', '=', 'eds.course_id').andOn('h.hole_number', '=', 'sh.hole_number');
        })
        .where({ 's.event_id': eventId, 's.day': day })
        .count({ total_holes: 'sh.id' })
        .sum({ four_pointers: db.raw("CASE WHEN COALESCE(sh.stableford_points, 0) = 4 THEN 1 ELSE 0 END") })
        .sum({ eagles: db.raw("CASE WHEN sh.gross_score <= (h.par - 2) AND sh.gross_score > 1 THEN 1 ELSE 0 END") })
        .sum({ aces: db.raw("CASE WHEN sh.gross_score = 1 THEN 1 ELSE 0 END") })
        .first();
      const dayHighlights = {
        totalHoles: Number(dayHighlightsRow?.total_holes || 0),
        fourPointers: Number(dayHighlightsRow?.four_pointers || 0),
        eagles: Number(dayHighlightsRow?.eagles || 0),
        aces: Number(dayHighlightsRow?.aces || 0)
      };
      const ntpResults = noveltyResults.filter((row) => String(row.noveltyType) === NOVELTY_TYPES.NTP);
      const longDriveResults = noveltyResults.filter((row) => String(row.noveltyType) === NOVELTY_TYPES.LONG_DRIVE);

      const activePlayerCountRow = await db('event_players')
        .where({ event_id: eventId, status: 'active' })
        .count({ total: '*' })
        .first();
      const activePlayerCount = Number(activePlayerCountRow?.total || 0);
      const skinsStake = Number(event.skins_amount_per_player_per_hole || 1);
      const baseSkinPot = activePlayerCount * skinsStake;
      const payoutSchedule = [];
      const pushPayout = (category, recipient, detail, amount) => {
        const value = Number(amount || 0);
        if (!Number.isFinite(value) || value <= 0) return;
        payoutSchedule.push({
          category: String(category || ''),
          recipient: String(recipient || '').trim() || '-',
          detail: String(detail || '').trim() || '-',
          amount: value
        });
      };

      if (isAmbroseDay) {
        const ambroseWinner = (ambroseTop5 || [])[0];
        const ambroseSecond = (ambroseTop5 || [])[1];
        if (ambroseWinner) pushPayout('Ambrose', ambroseWinner.name, 'Winner', Number(event.prize_ambrose_winner_amount || 0));
        if (ambroseSecond) pushPayout('Ambrose', ambroseSecond.name, '2nd', Number(event.prize_ambrose_second_amount || 0));
      } else {
        const dailyWinner = (individualTop5 || [])[0];
        const dailySecond = (individualTop5 || [])[1];
        if (dailyWinner) pushPayout('Daily', dailyWinner.name, 'Winner', Number(event.prize_daily_winner_amount || 0));
        if (dailySecond) pushPayout('Daily', dailySecond.name, '2nd', Number(event.prize_daily_second_amount || 0));
      }
      if (day === 4) {
        const sultansWinner = (sultansTop2 || [])[0];
        if (sultansWinner) pushPayout('Sultans', sultansWinner.name, 'Winner', Number(event.prize_sultans_winner_amount || 0));
      }

      (daySkinsSummary || []).forEach((row) => {
        const skinsCount = Number(row.skinsCount || 0);
        if (skinsCount <= 0) return;
        pushPayout('Skins', row.name, `${skinsCount} skin${skinsCount === 1 ? '' : 's'}`, skinsCount * baseSkinPot);
      });
      (ntpResults || []).forEach((row) => {
        if (row.isNoWinner || !row.winnerName) return;
        pushPayout('NTP', row.winnerName, `Hole ${Number(row.holeNumber || 0)} · ${row.label || 'NTP'}`, Number(event.prize_ntp_amount || 0));
      });
      (longDriveResults || []).forEach((row) => {
        if (row.isNoWinner || !row.winnerName) return;
        pushPayout('Long Drive', row.winnerName, `Hole ${Number(row.holeNumber || 0)} · ${row.label || 'Long Drive'}`, Number(event.prize_long_drive_amount || 0));
      });
      const dailyPayoutTotal = payoutSchedule.reduce((sum, row) => sum + Number(row.amount || 0), 0);

      return res.render('admin/presentation-sheet-print', {
        title: `Presentation Sheet ${event.year} ${dayLabel(day)}`,
        event,
        day,
        dayLabel: dayLabel(day),
        isAmbroseDay,
        dayFinalization,
        individualTop5,
        individualTop5WithCountback,
        individualShowCountback,
        tournamentTop5,
        tournamentShowCountback,
        ambroseTop5,
        eclecticTop3,
        sultansTop2,
        trophies,
        daySkinsSummary,
        daySkinWins,
        ntpResults,
        longDriveResults,
        payoutSchedule,
        dailyPayoutTotal,
        carryIntoDay,
        dayHighlights,
        carryToNextDay
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/events/:id/tee-sheet', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const day = parseDay(req.query.day, 1);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      const groupsOut = [];

      if (day === 1) {
        const groups = await db('ambrose_groups')
          .where({ event_id: eventId, day: 1 })
          .orderBy([{ column: 'tee_time', order: 'asc' }, { column: 'group_number', order: 'asc' }])
          .select('id', 'group_number', 'tee_time', 'tee_location', 'starting_hole');
        const teams = await db('teams')
          .where({ event_id: eventId, day: 1, competition_type: 'ambrose' })
          .select('id', 'name', 'ambrose_group_id')
          .orderBy('id', 'asc');
        const members = await db('team_members as tm')
          .join('users as u', 'u.id', 'tm.user_id')
          .whereIn('tm.team_id', teams.map((t) => t.id))
          .select('tm.team_id', 'u.first_name', 'u.last_name')
          .orderBy('u.last_name', 'asc');
        const membersByTeam = new Map();
        for (const m of members) {
          const key = Number(m.team_id);
          if (!membersByTeam.has(key)) membersByTeam.set(key, []);
          membersByTeam.get(key).push(`${m.first_name} ${m.last_name}`);
        }

        groups.forEach((group) => {
          const groupTeams = teams.filter((t) => Number(t.ambrose_group_id) === Number(group.id));
          const teamsOut = groupTeams.map((team) => ({
            name: team.name,
            members: membersByTeam.get(Number(team.id)) || []
          }));

          groupsOut.push({
            groupNumber: group.group_number,
            teeTime: group.tee_time,
            startingHole: group.starting_hole,
            teeLocation: group.tee_location || '-',
            teams: teamsOut,
            players: []
          });
        });
      } else {
        const groups = await db('tee_groups')
          .where({ event_id: eventId, day })
          .orderBy([{ column: 'tee_time', order: 'asc' }, { column: 'group_number', order: 'asc' }])
          .select('id', 'group_number', 'tee_time', 'tee_location', 'starting_hole');
        const players = await db('tee_group_players as tgp')
          .join('users as u', 'u.id', 'tgp.user_id')
          .whereIn('tgp.tee_group_id', groups.map((g) => g.id))
          .orderBy([{ column: 'tgp.tee_group_id', order: 'asc' }, { column: 'tgp.position', order: 'asc' }])
          .select('tgp.tee_group_id', 'u.first_name', 'u.last_name');
        const playersByGroup = new Map();
        for (const p of players) {
          const key = Number(p.tee_group_id);
          if (!playersByGroup.has(key)) playersByGroup.set(key, []);
          playersByGroup.get(key).push(`${p.first_name} ${p.last_name}`);
        }

        groups.forEach((group) => {
          groupsOut.push({
            groupNumber: group.group_number,
            teeTime: group.tee_time,
            startingHole: group.starting_hole,
            teeLocation: group.tee_location || '-',
            teams: [],
            players: playersByGroup.get(Number(group.id)) || []
          });
        });
      }

      return res.render('admin/tee-sheet-print', {
        title: `Tee Sheet ${event.year}`,
        event,
        day,
        dayLabel: dayLabel(day),
        groups: groupsOut
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/dashboard', requireAuth, requireRole([ROLES.ADMIN]), async (req, res) => {
    const [usersCount] = await db('users').count({ total: '*' });
    const [eventsCount] = await db('events').count({ total: '*' });

    const events = await db('events')
      .leftJoin('event_day_statuses as eds', 'eds.event_id', 'events.id')
      .select('events.id', 'events.year', 'events.location', 'events.start_date', 'events.end_date', 'events.is_active')
      .countDistinct({ courses_count: 'eds.course_id' })
      .groupBy('events.id', 'events.year', 'events.location', 'events.start_date', 'events.end_date', 'events.is_active')
      .orderBy('year', 'desc');
    const activeOrLatestEvent = events.find((e) => Number(e.is_active) === 1) || events[0] || null;

    const message = req.query.message ? String(req.query.message) : null;
    const error = req.query.error ? String(req.query.error) : null;

    return res.render('admin/dashboard', {
      title: 'Admin Dashboard',
      user: req.session.user,
      metrics: {
        users: Number(usersCount.total || 0),
        events: Number(eventsCount.total || 0)
      },
      events,
      activeOrLatestEvent,
      message,
      error
    });
  });

  router.get('/events/active', requireAuth, requireRole([ROLES.ADMIN]), async (_req, res) => {
    const activeEvent = await db('events').where({ is_active: 1 }).orderBy('year', 'desc').first();
    if (!activeEvent) {
      return res.redirect('/admin/dashboard?error=No%20active%20event%20configured');
    }
    return res.redirect(`/admin/events/${Number(activeEvent.id)}`);
  });

  router.get('/test-data', requireAuth, requireRole([ROLES.ADMIN]), ensureSeedToolUser, async (req, res, next) => {
    try {
      const event = await db('events').where({ id: TEST_DATA_EVENT_ID }).first();
      const seedUsers = await listSeedUsers(db);
      const eventPlayerCount = event
        ? Number((await db('event_players').where({ event_id: TEST_DATA_EVENT_ID }).count({ total: '*' }).first())?.total || 0)
        : 0;
      return res.render('admin/test-data', {
        title: 'Test Data Tools',
        user: req.session.user,
        event,
        seedUsers,
        eventPlayerCount,
        message: req.query.message ? String(req.query.message) : null,
        error: req.query.error ? String(req.query.error) : null
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/test-data/create-players', requireAuth, requireRole([ROLES.ADMIN]), ensureSeedToolUser, async (req, res, next) => {
    try {
      await ensureEventExists(db, TEST_DATA_EVENT_ID);
      await ensureDayStatusRows(db, TEST_DATA_EVENT_ID);

      await db.transaction(async (trx) => {
        for (let i = 1; i <= TEST_DATA_PLAYER_COUNT; i += 1) {
          const email = testSeedEmail(i);
          let user = await trx('users').where({ email }).first();
          if (!user) {
            const ids = await trx('users').insert({
              first_name: testSeedFirstName(i),
              last_name: testSeedLastName(i),
              email,
              phone_number: `040000${String(i).padStart(4, '0')}`,
              role: ROLES.PLAYER,
              is_previous_winner: 0
            });
            user = await trx('users').where({ id: Number(Array.isArray(ids) ? ids[0] : ids) }).first();
          }

          const inEvent = await trx('event_players').where({ event_id: TEST_DATA_EVENT_ID, user_id: user.id }).first();
          if (!inEvent) {
            await trx('event_players').insert({
              event_id: TEST_DATA_EVENT_ID,
              user_id: Number(user.id),
              status: 'active',
              is_previous_year_winner: 0
            });
          }
        }

        const ownerInEvent = await trx('event_players')
          .where({ event_id: TEST_DATA_EVENT_ID, user_id: TEST_DATA_OWNER_USER_ID })
          .first();
        if (!ownerInEvent) {
          await trx('event_players').insert({
            event_id: TEST_DATA_EVENT_ID,
            user_id: TEST_DATA_OWNER_USER_ID,
            status: 'active',
            is_previous_year_winner: 1
          });
        } else {
          await trx('event_players')
            .where({ event_id: TEST_DATA_EVENT_ID, user_id: TEST_DATA_OWNER_USER_ID })
            .update({ is_previous_year_winner: 1, updated_at: trx.fn.now() });
        }
        await trx('event_players')
          .where({ event_id: TEST_DATA_EVENT_ID })
          .whereNot({ user_id: TEST_DATA_OWNER_USER_ID })
          .update({ is_previous_year_winner: 0, updated_at: trx.fn.now() });

        const playerIds = await listSeedPlayerIdsForEvent(trx, TEST_DATA_EVENT_ID);
        const winnerCount = Math.min(6, playerIds.length);
        const shuffledForWinners = shuffleArray(playerIds);
        const winnerIds = new Set(shuffledForWinners.slice(0, winnerCount).map((id) => Number(id)));
        for (const userId of playerIds) {
          await trx('users')
            .where({ id: Number(userId) })
            .update({ is_previous_winner: winnerIds.has(Number(userId)) ? 1 : 0, updated_at: trx.fn.now() });
        }

        for (let idx = 0; idx < playerIds.length; idx += 1) {
          const userId = Number(playerIds[idx]);
          const handicap = seededHandicapForIndex(idx, playerIds.length);
          const existing = await trx('player_handicaps').where({ event_id: TEST_DATA_EVENT_ID, user_id: userId }).first();
          if (existing) {
            await trx('player_handicaps').where({ id: existing.id }).update({
              playing_handicap: handicap,
              updated_at: trx.fn.now()
            });
          } else {
            await trx('player_handicaps').insert({
              event_id: TEST_DATA_EVENT_ID,
              user_id: userId,
              playing_handicap: handicap
            });
          }
        }
      });

      return res.redirect('/admin/test-data?message=Created%2024%20test%20players%20%28plus%20seeded%20user%29%20and%20assigned%20handicaps%20%281%20plus%2C%20otherwise%207%20to%2026%2C%20avg%20~13%29');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/test-data/day-1-groups-teams', requireAuth, requireRole([ROLES.ADMIN]), ensureSeedToolUser, async (req, res, next) => {
    try {
      await ensureEventExists(db, TEST_DATA_EVENT_ID);
      const players = await buildEventPlayersWithProfile(db, TEST_DATA_EVENT_ID);
      if (players.length < 2) return res.redirect('/admin/test-data?error=Not%20enough%20players%20in%20event%201');
      const result = await createAmbroseGroupsAndTeams(db, TEST_DATA_EVENT_ID, players);
      return res.redirect(`/admin/test-data?message=Day%201%20created%20${result.groups}%20groups%20and%20${result.teams}%20teams`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/test-data/calcutta', requireAuth, requireRole([ROLES.ADMIN]), ensureSeedToolUser, async (req, res, next) => {
    try {
      await ensureEventExists(db, TEST_DATA_EVENT_ID);
      const playerIds = await listSeedPlayerIdsForEvent(db, TEST_DATA_EVENT_ID);
      if (playerIds.length < 2) return res.redirect('/admin/test-data?error=Create%20players%20first');
      const created = await seedCalcuttaDetails(db, TEST_DATA_EVENT_ID, playerIds);
      clearPendingCalcuttaUserId(req, TEST_DATA_EVENT_ID);
      return res.redirect(`/admin/test-data?message=Generated%20Calcutta%20details%20for%20${created}%20players`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/test-data/day-3-groups', requireAuth, requireRole([ROLES.ADMIN]), ensureSeedToolUser, async (req, res, next) => {
    try {
      const playerIds = await listSeedPlayerIdsForEvent(db, TEST_DATA_EVENT_ID);
      if (playerIds.length < 2) return res.redirect('/admin/test-data?error=Create%20players%20first');
      const groupsCreated = await createIndividualGroups(db, TEST_DATA_EVENT_ID, 3, playerIds);
      return res.redirect(`/admin/test-data?message=Day%203%20created%20${groupsCreated}%20groups`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/test-data/day-1-scores', requireAuth, requireRole([ROLES.ADMIN]), ensureSeedToolUser, async (req, res, next) => {
    try {
      const created = await seedDay1Scores(db, TEST_DATA_EVENT_ID);
      return res.redirect(`/admin/test-data?message=Day%201%20created%20scores%20for%20${created}%20teams`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/test-data/day-2-scores', requireAuth, requireRole([ROLES.ADMIN]), ensureSeedToolUser, async (req, res, next) => {
    try {
      const players = await buildEventPlayersWithProfile(db, TEST_DATA_EVENT_ID);
      const created = await seedIndividualDayScores(db, TEST_DATA_EVENT_ID, 2, players);
      return res.redirect(`/admin/test-data?message=Day%202%20created%20scores%20for%20${created}%20players`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/test-data/day-3-scores', requireAuth, requireRole([ROLES.ADMIN]), ensureSeedToolUser, async (req, res, next) => {
    try {
      const players = await buildEventPlayersWithProfile(db, TEST_DATA_EVENT_ID);
      const created = await seedIndividualDayScores(db, TEST_DATA_EVENT_ID, 3, players);
      return res.redirect(`/admin/test-data?message=Day%203%20created%20scores%20for%20${created}%20players`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/test-data/day-4-scores', requireAuth, requireRole([ROLES.ADMIN]), ensureSeedToolUser, async (req, res, next) => {
    try {
      const players = await buildEventPlayersWithProfile(db, TEST_DATA_EVENT_ID);
      const created = await seedIndividualDayScores(db, TEST_DATA_EVENT_ID, 4, players);
      return res.redirect(`/admin/test-data?message=Day%204%20created%20scores%20for%20${created}%20players`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/test-data/purge', requireAuth, requireRole([ROLES.ADMIN]), ensureSeedToolUser, async (req, res, next) => {
    try {
      await purgeTestEventData(db, TEST_DATA_EVENT_ID);
      return res.redirect('/admin/test-data?message=Purged%20test%20data%20for%20event%201%20and%20removed%20seeded%20players%20%28prize%20config%20preserved%29');
    } catch (error) {
      return next(error);
    }
  });

  router.get('/players', requireAuth, requireRole([ROLES.ADMIN]), async (req, res) => {
    const users = await db('users')
      .select('id', 'first_name', 'last_name', 'email', 'phone_number', 'role', 'is_previous_winner')
      .orderBy('last_name', 'asc');

    const message = req.query.message ? String(req.query.message) : null;
    const error = req.query.error ? String(req.query.error) : null;

    return res.render('admin/players', {
      title: 'Player Management',
      user: req.session.user,
      users,
      message,
      error
    });
  });

  router.get('/events/:id/calcutta', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const state = await buildCalcuttaViewState(db, req, eventId);
      if (!state) return res.redirect('/admin/dashboard?error=Event%20not%20found');
      return res.render('admin/calcutta', {
        title: `Calcutta ${state.event.year}`,
        user: req.session.user,
        ...state,
        message: req.query.message ? String(req.query.message) : null,
        error: req.query.error ? String(req.query.error) : null
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/events/:id/calcutta/projector', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const state = await buildCalcuttaViewState(db, req, eventId);
      if (!state) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      let displaySales = state.sales.slice(-18).reverse();
      if (state.allDrawn) {
        const defending = state.sales.find((row) => Number(row.auctioned_is_previous_year_winner || 0) === 1);
        if (defending) {
          displaySales = [
            defending,
            ...state.sales.filter((row) => Number(row.id) !== Number(defending.id))
          ];
        } else {
          displaySales = [...state.sales];
        }
      }
      if (state.allDrawn && Number(state.day2GroupCount || 0) > 0) {
        let previousGroup = null;
        displaySales = displaySales.map((row) => {
          const group = Number(state.day2GroupAssignments.get(Number(row.auctioned_user_id)) || 0);
          const shouldBreakBefore = previousGroup !== null && group > 0 && group !== previousGroup;
          previousGroup = group || previousGroup;
          return {
            ...row,
            day2_group_number: group || null,
            _groupBreakBefore: shouldBreakBefore
          };
        });
      }

      return res.render('admin/calcutta-projector', {
        title: `Calcutta Projector ${state.event.year}`,
        user: req.session.user,
        ...state,
        displaySales,
        message: req.query.message ? String(req.query.message) : null,
        error: req.query.error ? String(req.query.error) : null
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/calcutta/draw', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      if (getPendingCalcuttaUserId(req, eventId)) {
        return res.redirect(`/admin/events/${eventId}/calcutta?error=Auction%20the%20current%20drawn%20player%20before%20drawing%20again`);
      }

      const activePlayers = await db('event_players')
        .where({ event_id: eventId, status: 'active' })
        .pluck('user_id');
      const soldIds = await db('calcutta_auctions')
        .where({ event_id: eventId })
        .pluck('auctioned_user_id');
      const soldSet = new Set(soldIds.map((id) => Number(id)));
      const remaining = activePlayers.map((id) => Number(id)).filter((id) => !soldSet.has(id));
      if (!remaining.length) {
        return res.redirect(`/admin/events/${eventId}/calcutta?error=All%20players%20have%20already%20been%20drawn`);
      }

      const selected = remaining[Math.floor(Math.random() * remaining.length)];
      setPendingCalcuttaUserId(req, eventId, selected);
      return res.redirect(`/admin/events/${eventId}/calcutta?message=Player%20drawn%20for%20auction`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/calcutta/day2/generate', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      await generateDay2GroupsFromCalcuttaDraw(db, eventId);
      return res.redirect(`/admin/events/${eventId}/calcutta?message=Round%201%20groups%20generated%20from%20Calcutta`);
    } catch (error) {
      return res.redirect(`/admin/events/${Number(req.params.id)}/calcutta?error=${encodeURIComponent(error.message || 'Unable to generate Round 1 groups from Calcutta')}`);
    }
  });

  router.post('/events/:id/calcutta/sell', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const pendingUserId = getPendingCalcuttaUserId(req, eventId);
      if (!pendingUserId) {
        return res.redirect(`/admin/events/${eventId}/calcutta?error=Draw%20a%20player%20first`);
      }

      const soldPrice = Number(req.body.soldPrice);
      const buyerUserId = Number(req.body.buyerUserId || 0);
      const ownerRaw = String(req.body.ownerUserId || '').trim();
      const ownerUserId = ownerRaw ? Number(ownerRaw) : null;

      if (!Number.isFinite(soldPrice) || soldPrice <= 0) {
        return res.redirect(`/admin/events/${eventId}/calcutta?error=Sold%20price%20must%20be%20greater%20than%200`);
      }
      if (!Number.isInteger(buyerUserId) || buyerUserId <= 0) {
        return res.redirect(`/admin/events/${eventId}/calcutta?error=Buyer%20is%20required`);
      }

      const validRows = await db('event_players')
        .where({ event_id: eventId, status: 'active' })
        .whereIn('user_id', ownerUserId ? [buyerUserId, ownerUserId] : [buyerUserId])
        .pluck('user_id');
      const validSet = new Set(validRows.map((id) => Number(id)));
      if (!validSet.has(buyerUserId) || (ownerUserId && !validSet.has(ownerUserId))) {
        return res.redirect(`/admin/events/${eventId}/calcutta?error=Buyer%20or%20owner%20is%20not%20a%20valid%20event%20player`);
      }

      const existingForPlayer = await db('calcutta_auctions')
        .where({ event_id: eventId, auctioned_user_id: pendingUserId })
        .first();
      if (existingForPlayer) {
        clearPendingCalcuttaUserId(req, eventId);
        return res.redirect(`/admin/events/${eventId}/calcutta?error=This%20player%20is%20already%20sold`);
      }

      const nextOrderRow = await db('calcutta_auctions')
        .where({ event_id: eventId })
        .max({ maxDraw: 'draw_order' })
        .first();
      const nextDrawOrder = Number(nextOrderRow?.maxDraw || 0) + 1;

      await db('calcutta_auctions').insert({
        event_id: eventId,
        auctioned_user_id: pendingUserId,
        buyer_user_id: buyerUserId,
        owner_user_id: ownerUserId,
        auction_bid_amount: soldPrice,
        draw_order: nextDrawOrder
      });
      clearPendingCalcuttaUserId(req, eventId);

      const totalPlayersRow = await db('event_players')
        .where({ event_id: eventId, status: 'active' })
        .count({ total: '*' })
        .first();
      const drawnRow = await db('calcutta_auctions')
        .where({ event_id: eventId })
        .count({ total: '*' })
        .first();
      const totalPlayers = Number(totalPlayersRow?.total || 0);
      const drawn = Number(drawnRow?.total || 0);
      if (totalPlayers > 0 && drawn >= totalPlayers) {
        await generateDay2GroupsFromCalcuttaDraw(db, eventId);
        return res.redirect(`/admin/events/${eventId}/calcutta?message=Sale%20saved.%20All%20players%20drawn%20and%20Day%202%20groups%20generated`);
      }

      return res.redirect(`/admin/events/${eventId}/calcutta?message=Sale%20saved`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/calcutta/sales/:saleId/update', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const saleId = Number(req.params.saleId);
      const sale = await db('calcutta_auctions').where({ id: saleId, event_id: eventId }).first();
      if (!sale) return res.redirect(`/admin/events/${eventId}/calcutta?error=Sale%20record%20not%20found`);

      const soldPrice = Number(req.body.soldPrice);
      const buyerUserId = Number(req.body.buyerUserId || 0);
      const ownerRaw = String(req.body.ownerUserId || '').trim();
      const ownerUserId = ownerRaw ? Number(ownerRaw) : null;

      if (!Number.isFinite(soldPrice) || soldPrice <= 0) {
        return res.redirect(`/admin/events/${eventId}/calcutta?error=Sold%20price%20must%20be%20greater%20than%200`);
      }
      if (!Number.isInteger(buyerUserId) || buyerUserId <= 0) {
        return res.redirect(`/admin/events/${eventId}/calcutta?error=Buyer%20is%20required`);
      }

      const validRows = await db('event_players')
        .where({ event_id: eventId, status: 'active' })
        .whereIn('user_id', ownerUserId ? [buyerUserId, ownerUserId] : [buyerUserId])
        .pluck('user_id');
      const validSet = new Set(validRows.map((id) => Number(id)));
      if (!validSet.has(buyerUserId) || (ownerUserId && !validSet.has(ownerUserId))) {
        return res.redirect(`/admin/events/${eventId}/calcutta?error=Buyer%20or%20owner%20is%20not%20a%20valid%20event%20player`);
      }

      await db('calcutta_auctions')
        .where({ id: saleId })
        .update({
          buyer_user_id: buyerUserId,
          owner_user_id: ownerUserId,
          auction_bid_amount: soldPrice,
          updated_at: db.fn.now()
        });

      return res.redirect(`/admin/events/${eventId}/calcutta?message=Sale%20updated`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/calcutta/finalise', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      if (getPendingCalcuttaUserId(req, eventId)) {
        return res.redirect(`/admin/events/${eventId}/calcutta?error=Auction%20the%20current%20drawn%20player%20before%20finalising`);
      }

      const totalPlayersRow = await db('event_players')
        .where({ event_id: eventId, status: 'active' })
        .count({ total: '*' })
        .first();
      const drawnRow = await db('calcutta_auctions')
        .where({ event_id: eventId })
        .count({ total: '*' })
        .first();
      const ownerMissingRow = await db('calcutta_auctions')
        .where({ event_id: eventId })
        .whereNull('owner_user_id')
        .count({ total: '*' })
        .first();

      const totalPlayers = Number(totalPlayersRow?.total || 0);
      const drawn = Number(drawnRow?.total || 0);
      const missingOwners = Number(ownerMissingRow?.total || 0);
      if (drawn < totalPlayers) {
        return res.redirect(`/admin/events/${eventId}/calcutta?error=Draw%20all%20players%20before%20finalising`);
      }
      if (missingOwners > 0) {
        return res.redirect(`/admin/events/${eventId}/calcutta?error=Every%20player%20must%20have%20an%20owner%20before%20finalising`);
      }

      await generateDay2GroupsFromCalcuttaDraw(db, eventId);
      return res.redirect(`/admin/events/${eventId}/calcutta?message=Calcutta%20finalised%20and%20Day%202%20groups%20generated`);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/events/:id', requireAuth, requireRole([ROLES.ADMIN]), async (req, res) => {
    const eventId = Number(req.params.id);
    const event = await db('events').where({ id: eventId }).first();
    if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

    const eventPlayers = await db('event_players as ep')
      .join('users as u', 'u.id', 'ep.user_id')
      .leftJoin('player_handicaps as ph', function joinPh() {
        this.on('ph.user_id', '=', 'u.id').andOn('ph.event_id', '=', 'ep.event_id');
      })
      .where('ep.event_id', eventId)
      .select(
        'u.id',
        'u.first_name',
        'u.last_name',
        'u.phone_number',
        'u.is_previous_winner',
        'ep.is_previous_year_winner',
        'ep.status',
        'ph.playing_handicap'
      )
      .orderBy('u.last_name', 'asc');

    const allUsers = await db('users')
      .select('id', 'first_name', 'last_name', 'email', 'role', 'is_previous_winner')
      .orderBy('last_name', 'asc');

    const inEvent = new Set(eventPlayers.map((p) => p.id));
    const availableUsers = allUsers.filter((u) => !inEvent.has(u.id));

    const message = req.query.message ? String(req.query.message) : null;
    const error = req.query.error ? String(req.query.error) : null;
    const hasAnyScores = await hasRecordedScoresForEvent(db, eventId);

    return res.render('admin/event-setup', {
      title: `Event Setup ${event.year}`,
      user: req.session.user,
      event,
      eventPlayers,
      availableUsers,
      hasAnyScores,
      message,
      error
    });
  });

  router.get('/courses', requireAuth, requireRole([ROLES.ADMIN]), async (req, res) => {
    const courses = await db('courses')
      .leftJoin('holes', 'holes.course_id', 'courses.id')
      .groupBy('courses.id', 'courses.course_name', 'courses.tee_name')
      .select('courses.id', 'courses.course_name', 'courses.tee_name')
      .count({ holes_count: 'holes.id' })
      .orderBy([{ column: 'courses.course_name', order: 'asc' }, { column: 'courses.tee_name', order: 'asc' }]);

    const message = req.query.message ? String(req.query.message) : null;
    const error = req.query.error ? String(req.query.error) : null;
    return res.render('admin/courses', {
      title: 'Courses',
      user: req.session.user,
      courses,
      message,
      error
    });
  });

  router.post('/courses', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const courseName = String(req.body.courseName || '').trim();
      const teeName = String(req.body.teeName || '').trim();
      const seedBonville = req.body.seedBonville === 'on';
      if (!courseName || !teeName) {
        return res.redirect('/admin/courses?error=Course%20name%20and%20tee%20name%20are%20required');
      }

      const existing = await db('courses')
        .whereRaw('LOWER(course_name) = ?', [courseName.toLowerCase()])
        .andWhereRaw('LOWER(tee_name) = ?', [teeName.toLowerCase()])
        .first();
      if (existing) {
        return res.redirect('/admin/courses?error=That%20course%20and%20tee%20already%20exists');
      }

      const ids = await db('courses').insert({
        course_name: courseName,
        tee_name: teeName
      });
      const courseId = Number(Array.isArray(ids) ? ids[0] : ids);

      if (seedBonville) {
        for (const hole of BONVILLE_WHITE_HOLES) {
          await db('holes').insert({
            course_id: courseId,
            hole_number: hole.hole,
            par: hole.par,
            length_meters: hole.meters,
            stroke_index_primary: hole.si,
            stroke_index_secondary: hole.si + 18
          });
        }
      }

      return res.redirect('/admin/courses?message=Course%20added');
    } catch (error) {
      return next(error);
    }
  });

  router.get('/events/:id/setup', requireAuth, requireRole([ROLES.ADMIN]), async (req, res) => {
    const eventId = Number(req.params.id);
    const event = await db('events').where({ id: eventId }).first();
    if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

    const courses = await db('courses')
      .leftJoin('holes', 'holes.course_id', 'courses.id')
      .groupBy('courses.id', 'courses.course_name', 'courses.tee_name')
      .select('courses.id', 'courses.course_name', 'courses.tee_name')
      .count({ holes_count: 'holes.id' })
      .orderBy([{ column: 'courses.course_name', order: 'asc' }, { column: 'courses.tee_name', order: 'asc' }]);

    const [dayRows, noveltyEventsByDay] = await Promise.all([
      Promise.all([1, 2, 3, 4].map((day) => getOrCreateDayStatus(db, eventId, day))),
      getNoveltyEventsForEvent(db, eventId)
    ]);
    const dayAssignments = new Map(dayRows.map((row) => [Number(row.day), Number(row.course_id || 0)]));
    const assignedCourseIds = [...new Set(dayRows.map((row) => Number(row.course_id || 0)).filter((id) => id > 0))];
    const holesByCourse = new Map();
    if (assignedCourseIds.length) {
      const holeRows = await db('holes')
        .whereIn('course_id', assignedCourseIds)
        .orderBy([{ column: 'course_id', order: 'asc' }, { column: 'hole_number', order: 'asc' }])
        .select('course_id', 'hole_number', 'par');
      holeRows.forEach((row) => {
        const courseId = Number(row.course_id);
        if (!holesByCourse.has(courseId)) holesByCourse.set(courseId, []);
        holesByCourse.get(courseId).push({
          holeNumber: Number(row.hole_number || 0),
          par: Number(row.par || 0)
        });
      });
    }
    const noveltyHoleOptionsByDay = new Map();
    [1, 2, 3, 4].forEach((day) => {
      const courseId = Number(dayAssignments.get(day) || 0);
      noveltyHoleOptionsByDay.set(day, holesByCourse.get(courseId) || []);
    });
    const message = req.query.message ? String(req.query.message) : null;
    const error = req.query.error ? String(req.query.error) : null;
    const activePlayerCountRow = await db('event_players')
      .where({ event_id: eventId, status: 'active' })
      .count({ count: '*' })
      .first();
    const activePlayerCount = Math.max(0, Number(activePlayerCountRow?.count || 0));
    const mysteryPlaceOptions = Array.from({ length: activePlayerCount }, (_, idx) => {
      const place = idx + 1;
      return { value: place, label: formatOrdinal(place) };
    });
    const prizeConfig = {
      prizeSultansWinnerAmount: Number(event.prize_sultans_winner_amount || 0),
      prizeAmbroseWinnerAmount: Number(event.prize_ambrose_winner_amount || 0),
      prizeAmbroseSecondAmount: Number(event.prize_ambrose_second_amount || 0),
      prizeDailyWinnerAmount: Number(event.prize_daily_winner_amount || 0),
      prizeDailySecondAmount: Number(event.prize_daily_second_amount || 0),
      skinsAmountPerPlayerPerHole: Number(event.skins_amount_per_player_per_hole || 1),
      prizeNtpAmount: Number(event.prize_ntp_amount || 0),
      prizeLongDriveAmount: Number(event.prize_long_drive_amount || 0),
      calcuttaOwnerDailyWinnerPercent: Number(event.calcutta_owner_daily_winner_percent || 5),
      calcuttaChampionPercent: Number(event.calcutta_champion_percent || 10),
      calcuttaChampionOwnerPercent: Number(event.calcutta_champion_owner_percent || 70),
      calcuttaMysteryPlace: normalizeNullablePositiveInt(event.calcutta_mystery_place),
      calcuttaMysteryPlacePercent: Number(event.calcutta_mystery_place_percent || 5)
    };
    const noveltyRows = Array.from(noveltyEventsByDay.values()).flat();
    const ntpCount = noveltyRows.filter((row) => String(row.noveltyType || '') === NOVELTY_TYPES.NTP).length;
    const longDriveCount = noveltyRows.filter((row) => String(row.noveltyType || '') === NOVELTY_TYPES.LONG_DRIVE).length;
    const totalHoles = dayRows.reduce((sum, row) => {
      const dayCourseId = Number(row.course_id || 0);
      if (!dayCourseId) return sum;
      const count = Number((holesByCourse.get(dayCourseId) || []).length || 0);
      return sum + count;
    }, 0);
    const payoutSultans = Number(prizeConfig.prizeSultansWinnerAmount || 0);
    const payoutAmbrose = Number(prizeConfig.prizeAmbroseWinnerAmount || 0) + Number(prizeConfig.prizeAmbroseSecondAmount || 0);
    const payoutDailyWinner = Number(prizeConfig.prizeDailyWinnerAmount || 0) * 4;
    const payoutDailySecond = Number(prizeConfig.prizeDailySecondAmount || 0) * 4;
    const payoutNtp = Number(prizeConfig.prizeNtpAmount || 0) * ntpCount;
    const payoutLongDrive = Number(prizeConfig.prizeLongDriveAmount || 0) * longDriveCount;
    const payoutSkins = Number(prizeConfig.skinsAmountPerPlayerPerHole || 0) * activePlayerCount * totalHoles;
    const totalPrizePool = payoutSultans + payoutAmbrose + payoutDailyWinner + payoutDailySecond + payoutNtp + payoutLongDrive + payoutSkins;
    const perPlayerFunding = activePlayerCount > 0 ? (totalPrizePool / activePlayerCount) : 0;
    const perPlayerPerDayFunding = perPlayerFunding / 4;
    const prizeSummary = {
      activePlayerCount,
      ntpCount,
      longDriveCount,
      totalHoles,
      payoutSultans,
      payoutAmbrose,
      payoutDailyWinner,
      payoutDailySecond,
      payoutNtp,
      payoutLongDrive,
      payoutSkins,
      totalPrizePool,
      perPlayerFunding,
      perPlayerPerDayFunding
    };

    return res.render('admin/event-courses', {
      title: `Event Setup ${event.year}`,
      user: req.session.user,
      event,
      courses,
      dayAssignments,
      noveltyEventsByDay,
      noveltyHoleOptionsByDay,
      noveltyTypes: [NOVELTY_TYPES.NTP, NOVELTY_TYPES.LONG_DRIVE],
      prizeConfig,
      prizeSummary,
      mysteryPlaceOptions,
      message,
      error
    });
  });

  router.post('/events/:id/setup/assign', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      const selectedByDay = new Map();
      for (const day of [1, 2, 3, 4]) {
        const courseId = Number(req.body[`courseId_${day}`] || 0);
        if (courseId > 0) selectedByDay.set(day, courseId);
      }

      const selectedIds = [...selectedByDay.values()];
      if (selectedIds.length) {
        const validRows = await db('courses').whereIn('id', selectedIds).select('id');
        const validIds = new Set(validRows.map((r) => Number(r.id)));
        for (const [day, courseId] of selectedByDay.entries()) {
          if (!validIds.has(courseId)) {
            return res.redirect(`/admin/events/${eventId}/setup?error=Invalid%20course%20selection%20for%20${encodeURIComponent(dayLabel(day))}`);
          }
        }
      }

      for (const day of [1, 2, 3, 4]) {
        const existing = await getOrCreateDayStatus(db, eventId, day);
        const nextCourseId = selectedByDay.get(day) || 0;
        if (!nextCourseId) {
          return res.redirect(`/admin/events/${eventId}/setup?error=Course%20is%20required%20for%20${encodeURIComponent(dayLabel(day))}`);
        }
        await db('event_day_statuses')
          .where({ id: existing.id })
          .update({ course_id: nextCourseId, updated_at: db.fn.now() });
      }

      return res.redirect(`/admin/events/${eventId}/setup?message=Day%20course%20assignments%20updated`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/setup/prizes', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      const payload = {
        prize_sultans_winner_amount: parseNonNegativeMoney(req.body.prizeSultansWinnerAmount, 0).toFixed(2),
        prize_ambrose_winner_amount: parseNonNegativeMoney(req.body.prizeAmbroseWinnerAmount, 0).toFixed(2),
        prize_ambrose_second_amount: parseNonNegativeMoney(req.body.prizeAmbroseSecondAmount, 0).toFixed(2),
        prize_daily_winner_amount: parseNonNegativeMoney(req.body.prizeDailyWinnerAmount, 0).toFixed(2),
        prize_daily_second_amount: parseNonNegativeMoney(req.body.prizeDailySecondAmount, 0).toFixed(2),
        skins_amount_per_player_per_hole: parseNonNegativeMoney(req.body.skinsAmountPerPlayerPerHole, 1).toFixed(2),
        prize_ntp_amount: parseNonNegativeMoney(req.body.prizeNtpAmount, 0).toFixed(2),
        prize_long_drive_amount: parseNonNegativeMoney(req.body.prizeLongDriveAmount, 0).toFixed(2),
        calcutta_owner_daily_winner_percent: parseNonNegativePercent(req.body.calcuttaOwnerDailyWinnerPercent, 5).toFixed(2),
        calcutta_champion_percent: parseNonNegativePercent(req.body.calcuttaChampionPercent, 10).toFixed(2),
        calcutta_champion_owner_percent: parseNonNegativePercent(req.body.calcuttaChampionOwnerPercent, 70).toFixed(2),
        calcutta_mystery_place_percent: parseNonNegativePercent(req.body.calcuttaMysteryPlacePercent, 5).toFixed(2),
        calcutta_mystery_place: normalizeNullablePositiveInt(req.body.calcuttaMysteryPlace),
        updated_at: db.fn.now()
      };

      const percentTotal = (Number(payload.calcutta_owner_daily_winner_percent) * 3)
        + Number(payload.calcutta_champion_percent)
        + Number(payload.calcutta_champion_owner_percent)
        + Number(payload.calcutta_mystery_place_percent);
      if (Math.abs(percentTotal - 100) > 0.0001) {
        return res.redirect(`/admin/events/${eventId}/setup?error=Calcutta%20percentages%20must%20total%20100%25%20(Owner%20Daily%20Winner%20%%20is%20applied%20x3)`);
      }

      await db('events').where({ id: eventId }).update(payload);
      return res.redirect(`/admin/events/${eventId}/setup?message=Prize%20config%20updated`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/setup/novelties', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      const day = parseDay(req.body.day, 1);
      const dayStatus = await getOrCreateDayStatus(db, eventId, day);
      const holeNumber = Number(req.body.holeNumber || 0);
      const noveltyType = normalizeNoveltyType(req.body.noveltyType);
      const labelInput = String(req.body.label || '').trim();

      if (!Number.isInteger(holeNumber) || holeNumber < 1 || holeNumber > 18) {
        return res.redirect(`/admin/events/${eventId}/setup?error=Select%20a%20valid%20hole%20for%20${encodeURIComponent(dayLabel(day))}`);
      }
      if (!noveltyType) {
        return res.redirect(`/admin/events/${eventId}/setup?error=Select%20a%20valid%20novelty%20type%20for%20${encodeURIComponent(dayLabel(day))}`);
      }
      if (!dayStatus.course_id) {
        return res.redirect(`/admin/events/${eventId}/setup?error=Assign%20a%20course%20for%20${encodeURIComponent(dayLabel(day))}%20before%20adding%20novelties`);
      }

      const holeExists = await db('holes')
        .where({ course_id: dayStatus.course_id, hole_number: holeNumber })
        .first('id');
      if (!holeExists) {
        return res.redirect(`/admin/events/${eventId}/setup?error=Hole%20${encodeURIComponent(String(holeNumber))}%20does%20not%20exist%20for%20${encodeURIComponent(dayLabel(day))}`);
      }

      await db('novelty_events').insert({
        event_id: eventId,
        day,
        course_id: Number(dayStatus.course_id),
        hole_number: holeNumber,
        novelty_type: noveltyType,
        label: labelInput || defaultNoveltyLabel(noveltyType)
      });

      return res.redirect(`/admin/events/${eventId}/setup?message=Novelty%20added%20for%20${encodeURIComponent(dayLabel(day))}`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/setup/novelties/:noveltyId/delete', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const noveltyId = Number(req.params.noveltyId);
      const novelty = await db('novelty_events').where({ id: noveltyId, event_id: eventId }).first();
      if (!novelty) return res.redirect(`/admin/events/${eventId}/setup?error=Novelty%20not%20found`);
      await db('novelty_events').where({ id: noveltyId }).del();
      return res.redirect(`/admin/events/${eventId}/setup?message=Novelty%20deleted`);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/events/:id/tee-times', requireAuth, requireRole([ROLES.ADMIN]), async (req, res) => {
    const eventId = Number(req.params.id);
    const day = parseIndividualDay(req.query.day, 2);
    const event = await db('events').where({ id: eventId }).first();
    if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

    const eventPlayers = await db('event_players as ep')
      .join('users as u', 'u.id', 'ep.user_id')
      .leftJoin('player_handicaps as ph', function joinPh() {
        this.on('ph.user_id', '=', 'u.id').andOn('ph.event_id', '=', 'ep.event_id');
      })
      .where('ep.event_id', eventId)
      .select(
        'u.id',
        'u.first_name',
        'u.last_name',
        'u.is_previous_winner',
        'ep.is_previous_year_winner',
        'ph.playing_handicap'
      )
      .orderBy('u.last_name', 'asc');
    const eventPlayersWithHcp = eventPlayers.map((p) => ({ ...p, handicap_display: formatHandicapDisplay(p.playing_handicap) }));

    const groups = await db('tee_groups')
      .where({ event_id: eventId, day })
      .orderBy([{ column: 'tee_time', order: 'asc' }, { column: 'starting_hole', order: 'asc' }, { column: 'group_number', order: 'asc' }])
      .select('id', 'day', 'tee_time', 'tee_location', 'starting_hole', 'group_number', 'source');
    const startingHoleTotals = new Map();
    for (const group of groups) {
      const hole = Number(group.starting_hole || 0);
      startingHoleTotals.set(hole, Number(startingHoleTotals.get(hole) || 0) + 1);
    }
    const startingHoleSeen = new Map();
    const groupsWithLabels = groups.map((group) => {
      const hole = Number(group.starting_hole || 0);
      const seen = Number(startingHoleSeen.get(hole) || 0) + 1;
      startingHoleSeen.set(hole, seen);
      const total = Number(startingHoleTotals.get(hole) || 0);
      const suffix = total > 1 ? String.fromCharCode(64 + Math.min(seen, 26)) : '';
      return {
        ...group,
        display_group_label: `${hole}${suffix}`
      };
    });
    const dayStatus = await getOrCreateDayStatus(db, eventId, day);

    const playersByGroup = new Map();
    const assignedUserIds = new Set();
    if (groups.length) {
      const groupIds = groups.map((g) => g.id);
      const groupPlayers = await db('tee_group_players as tgp')
        .join('users as u', 'u.id', 'tgp.user_id')
        .whereIn('tgp.tee_group_id', groupIds)
        .orderBy('tgp.position', 'asc')
        .select('tgp.tee_group_id', 'u.id', 'u.first_name', 'u.last_name', 'u.is_previous_winner');

      for (const row of groupPlayers) {
        if (!playersByGroup.has(row.tee_group_id)) playersByGroup.set(row.tee_group_id, []);
        playersByGroup.get(row.tee_group_id).push(row);
        assignedUserIds.add(Number(row.id));
      }
    }

    const unassignedPlayers = eventPlayersWithHcp.filter((p) => !assignedUserIds.has(Number(p.id)));

    const message = req.query.message ? String(req.query.message) : null;
    const error = req.query.error ? String(req.query.error) : null;
    const dayScoreCount = await countRecordedScoresForDay(db, eventId, day);
    const dayFinalization = await getDayFinalizationSummary(db, eventId, day);
    const assignedIds = [...assignedUserIds];
    const individualSummaries = dayFinalization.isFinalized
      ? await getIndividualScoreSummariesForDay(db, eventId, day, assignedIds)
      : new Map();
    const [noveltyEvents, noveltyOptions] = await Promise.all([
      getNoveltyEventsForDayWithResults(db, eventId, day),
      getNoveltySelectionOptionsForDay(db, eventId, day)
    ]);

    return res.render('admin/tee-times', {
      title: `Tee Times ${dayLabel(day)}`,
      user: req.session.user,
      event,
      day,
      eventPlayers: eventPlayersWithHcp,
      groups: groupsWithLabels,
      dayStatus,
      dayScoreCount,
      dayFinalization,
      noveltyEvents,
      noveltyOptions,
      playersByGroup,
      individualSummaries,
      unassignedPlayers,
      message,
      error
    });
  });

  router.post('/events/:id/day-status', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const status = String(req.body.status || '').trim();
      const returnTo = String(req.body.returnTo || 'tee-times');
      const day = returnTo === 'tee-times' ? parseIndividualDay(req.body.day, 2) : parseDay(req.body.day, 1);

      if (!['draft', 'open_scoring'].includes(status)) {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=${day}&error=Invalid%20status`);
      }

      const existing = await getOrCreateDayStatus(db, eventId, day);
      if (status === 'open_scoring') {
        const openConfirmed = String(req.body.openConfirmed || '').trim() === 'yes';
        const openingFromDraft = existing.status !== 'open_scoring';
        if (openingFromDraft && !openConfirmed) {
          const base = returnTo === 'ambrose' ? `/admin/events/${eventId}/ambrose` : `/admin/events/${eventId}/tee-times?day=${day}`;
          return res.redirect(`${base}${base.includes('?') ? '&' : '?'}error=${encodeURIComponent('Confirm that you are ready to open scoring for this day.')}`);
        }
        const dayRow = await getOrCreateDayStatus(db, eventId, day);
        if (!dayRow.course_id) {
          const base = returnTo === 'ambrose' ? `/admin/events/${eventId}/ambrose` : `/admin/events/${eventId}/tee-times?day=${day}`;
          return res.redirect(`${base}${base.includes('?') ? '&' : '?'}error=Assign%20a%20course%20for%20${encodeURIComponent(dayLabel(day))}%20before%20opening%20scoring`);
        }
        await ensureDayScorecards(db, eventId, day);
        if (Number(day) === 2) {
          await ensureSultansTeamsFromDay2(db, eventId);
        }
      }

      if (status === 'draft' && existing.status !== 'draft') {
        const scoreCount = await countRecordedScoresForDay(db, eventId, day);
        const purgeConfirmed = String(req.body.purgeText || '').trim().toUpperCase() === 'PURGE';
        if (scoreCount > 0 && !purgeConfirmed) {
          const base = returnTo === 'ambrose' ? `/admin/events/${eventId}/ambrose` : `/admin/events/${eventId}/tee-times?day=${day}`;
          return res.redirect(`${base}${base.includes('?') ? '&' : '?'}error=${encodeURIComponent(`Day has ${scoreCount} recorded scores. Type PURGE to confirm before reverting to draft.`)}`);
        }
        if (scoreCount > 0 && purgeConfirmed) {
          const scorecardIds = await db('scorecards')
            .where({ event_id: eventId, day })
            .pluck('id');
          if (scorecardIds.length) {
            await db('ambrose_drives').whereIn('scorecard_id', scorecardIds).del();
            await db('scorecard_holes').whereIn('scorecard_id', scorecardIds).del();
            await db('scorecard_edit_logs').whereIn('scorecard_id', scorecardIds).del();
            await db('scorecards')
              .whereIn('id', scorecardIds)
              .update({ status: 'draft', updated_at: db.fn.now() });
            await db('novelty_results').where({ event_id: eventId, day }).del();
            await markLeaderboardDirty(db, eventId);
          }
        }
        if (Number(day) === 2) {
          const sultansTeamIds = await db('teams')
            .where({ event_id: eventId, day: 2, competition_type: 'sultans' })
            .pluck('id');
          if (sultansTeamIds.length) {
            await db('team_members').whereIn('team_id', sultansTeamIds).del();
            await db('scorecards').where({ event_id: eventId, type: 'team' }).whereIn('team_id', sultansTeamIds).del();
            await db('teams').whereIn('id', sultansTeamIds).del();
            await markLeaderboardDirty(db, eventId);
          }
        }
      }
      await db('event_day_statuses').where({ id: existing.id }).update({ status, updated_at: db.fn.now() });

      const base = returnTo === 'ambrose' ? `/admin/events/${eventId}/ambrose` : `/admin/events/${eventId}/tee-times?day=${day}`;
      return res.redirect(`${base}${base.includes('?') ? '&' : '?'}message=Day%20status%20updated`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/day/:day/publish', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const day = parseDay(req.params.day, 1);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      const daySummary = await getDayFinalizationSummary(db, eventId, day);
      if (!daySummary.isFinalized) {
        const base = day === 1 ? `/admin/events/${eventId}/ambrose` : `/admin/events/${eventId}/tee-times?day=${day}`;
        return res.redirect(`${base}${base.includes('?') ? '&' : '?'}error=${encodeURIComponent(`${dayLabel(day)} is not finalized`)}`);
      }

      const status = await getOrCreateDayStatus(db, eventId, day);
      await db('event_day_statuses')
        .where({ id: status.id })
        .update({ leaderboard_published: 1, updated_at: db.fn.now() });

      const base = day === 1 ? `/admin/events/${eventId}/ambrose` : `/admin/events/${eventId}/tee-times?day=${day}`;
      return res.redirect(`${base}${base.includes('?') ? '&' : '?'}message=${encodeURIComponent(`${dayLabel(day)} published`)}`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/day/:day/unpublish', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const day = parseDay(req.params.day, 1);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      const status = await getOrCreateDayStatus(db, eventId, day);
      await db('event_day_statuses')
        .where({ id: status.id })
        .update({ leaderboard_published: 0, updated_at: db.fn.now() });

      const base = day === 1 ? `/admin/events/${eventId}/ambrose` : `/admin/events/${eventId}/tee-times?day=${day}`;
      return res.redirect(`${base}${base.includes('?') ? '&' : '?'}message=${encodeURIComponent(`${dayLabel(day)} unpublished`)}`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/day/:day/novelties/results', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const day = parseDay(req.params.day, 1);
      const returnTo = String(req.body.returnTo || (day === 1 ? 'ambrose' : 'tee-times'));
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      const noveltyRows = await db('novelty_events')
        .where({ event_id: eventId, day })
        .orderBy([{ column: 'hole_number', order: 'asc' }, { column: 'id', order: 'asc' }])
        .select('id');
      if (!noveltyRows.length) {
        const base = returnTo === 'ambrose' ? `/admin/events/${eventId}/ambrose` : `/admin/events/${eventId}/tee-times?day=${day}`;
        return res.redirect(`${base}${base.includes('?') ? '&' : '?'}error=No%20novelty%20events%20configured%20for%20this%20day`);
      }

      for (const row of noveltyRows) {
        const selected = String(req.body[`result_${Number(row.id)}`] || '').trim();
        if (!selected) {
          const base = returnTo === 'ambrose' ? `/admin/events/${eventId}/ambrose` : `/admin/events/${eventId}/tee-times?day=${day}`;
          return res.redirect(`${base}${base.includes('?') ? '&' : '?'}error=All%20novelty%20results%20are%20required`);
        }
      }

      await db.transaction(async (trx) => {
        for (const row of noveltyRows) {
          const selected = String(req.body[`result_${Number(row.id)}`] || '').trim();
          await upsertNoveltyResult(trx, eventId, day, Number(row.id), selected);
        }
      });

      const base = returnTo === 'ambrose' ? `/admin/events/${eventId}/ambrose` : `/admin/events/${eventId}/tee-times?day=${day}`;
      return res.redirect(`${base}${base.includes('?') ? '&' : '?'}message=Novelty%20results%20saved`);
    } catch (error) {
      const eventId = Number(req.params.id);
      const day = parseDay(req.params.day, 1);
      const returnTo = String(req.body.returnTo || (day === 1 ? 'ambrose' : 'tee-times'));
      const base = returnTo === 'ambrose' ? `/admin/events/${eventId}/ambrose` : `/admin/events/${eventId}/tee-times?day=${day}`;
      if (String(error.message || '').includes('invalid_selection') || String(error.message || '').includes('invalid_novelty')) {
        return res.redirect(`${base}${base.includes('?') ? '&' : '?'}error=Invalid%20novelty%20winner%20selection`);
      }
      return next(error);
    }
  });

  router.post('/events/:id/tee-times', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const day = parseIndividualDay(req.query.day || req.body.day, 2);
      const teeTime = String(req.body.teeTime || '').trim();
      const startingHole = Number(req.body.startingHole || 1);

      const dayStatus = await getOrCreateDayStatus(db, eventId, day);
      if (dayStatus.status !== 'draft') {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=${day}&error=Day%20is%20not%20in%20draft`);
      }

      if (!teeTime) return res.redirect(`/admin/events/${eventId}/tee-times?day=${day}&error=Tee%20time%20is%20required`);
      if (!Number.isInteger(startingHole) || startingHole < 1 || startingHole > 18) {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=${day}&error=Starting%20hole%20must%20be%201%20to%2018`);
      }

      await db('tee_groups').insert({
        event_id: eventId,
        day,
        tee_time: teeTime,
        tee_location: null,
        starting_hole: startingHole,
        group_number: 9999,
        source: 'manual'
      });
      await normalizeTeeGroupsForDay(db, eventId, day);

      return res.redirect(`/admin/events/${eventId}/tee-times?day=${day}&message=Group%20created`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/tee-times/:groupId/update', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const groupId = Number(req.params.groupId);
      const day = parseIndividualDay(req.query.day, 2);

      const group = await db('tee_groups').where({ id: groupId, event_id: eventId }).first();
      if (!group) return res.redirect(`/admin/events/${eventId}/tee-times?day=${day}&error=Group%20not%20found`);

      const dayStatus = await getOrCreateDayStatus(db, eventId, group.day);
      if (dayStatus.status !== 'draft') {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&error=Day%20is%20not%20in%20draft`);
      }

      const teeTime = String(req.body.teeTime || '').trim();
      const startingHole = Number(req.body.startingHole || 1);
      const cascadeAfterSameTee = String(req.body.cascadeAfterSameTee || '').trim() === '1';

      if (!teeTime) return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&error=Tee%20time%20is%20required`);
      if (!Number.isInteger(startingHole) || startingHole < 1 || startingHole > 18) {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&error=Starting%20hole%20must%20be%201%20to%2018`);
      }

      const oldMinutes = parseTimeToMinutes(String(group.tee_time || '').slice(0, 5));
      const newMinutes = parseTimeToMinutes(String(teeTime || '').slice(0, 5));
      const deltaMinutes = (oldMinutes === null || newMinutes === null) ? 0 : (newMinutes - oldMinutes);

      let cascadedCount = 0;
      await db.transaction(async (trx) => {
        await trx('tee_groups')
          .where({ id: group.id })
          .update({
            tee_time: teeTime,
            tee_location: null,
            starting_hole: startingHole,
            updated_at: trx.fn.now()
          });

        if (cascadeAfterSameTee && deltaMinutes !== 0 && oldMinutes !== null) {
          const sameTeeRows = await trx('tee_groups')
            .where({ event_id: eventId, day: group.day, starting_hole: Number(group.starting_hole || 0) })
            .orderBy([{ column: 'tee_time', order: 'asc' }, { column: 'group_number', order: 'asc' }, { column: 'id', order: 'asc' }])
            .select('id', 'tee_time', 'group_number');
          const currentIndex = sameTeeRows.findIndex((row) => Number(row.id) === Number(group.id));
          const toCascade = currentIndex >= 0
            ? sameTeeRows.slice(currentIndex + 1).filter((row) => Number(row.id) !== Number(group.id))
            : sameTeeRows.filter((row) => Number(row.id) !== Number(group.id));

          for (const row of toCascade) {
            const rowMinutes = parseTimeToMinutes(String(row.tee_time || '').slice(0, 5));
            if (rowMinutes === null) continue;
            await trx('tee_groups')
              .where({ id: Number(row.id) })
              .update({
                tee_time: minutesToTime(rowMinutes + deltaMinutes),
                updated_at: trx.fn.now()
              });
            cascadedCount += 1;
          }
        }
      });
      await normalizeTeeGroupsForDay(db, eventId, group.day);
      if (cascadeAfterSameTee && cascadedCount > 0) {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&message=${encodeURIComponent(`Group updated and cascaded to ${cascadedCount} later group(s) on the same tee`)}`);
      }
      return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&message=Group%20updated`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/tee-times/day4/generate', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const day = 4;
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      const dayStatus = await getOrCreateDayStatus(db, eventId, day);
      if (dayStatus.status !== 'draft') {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=4&error=Day%204%20must%20be%20draft%20to%20generate%20groups`);
      }

      const players = await db('event_players as ep')
        .join('users as u', 'u.id', 'ep.user_id')
        .where({ 'ep.event_id': eventId })
        .select('u.id', 'u.first_name', 'u.last_name');

      if (!players.length) {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=4&error=No%20players%20in%20event`);
      }

      const totals = await db('scorecards as s')
        .leftJoin('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
        .where({ 's.event_id': eventId, 's.type': 'individual' })
        .whereIn('s.day', [2, 3, 4])
        .groupBy('s.user_id')
        .select('s.user_id')
        .sum({ total_stableford: 'sh.stableford_points' });
      const totalByUser = new Map(totals.map((r) => [Number(r.user_id), Number(r.total_stableford || 0)]));

      const leaderboardDesc = [...players].sort((a, b) => {
        const scoreDiff = (totalByUser.get(Number(b.id)) || 0) - (totalByUser.get(Number(a.id)) || 0);
        if (scoreDiff !== 0) return scoreDiff;
        const last = String(a.last_name || '').localeCompare(String(b.last_name || ''));
        if (last !== 0) return last;
        return String(a.first_name || '').localeCompare(String(b.first_name || ''));
      });

      // Day 4 plays in reverse leaderboard order: worst first in Group 1.
      const orderedPlayers = leaderboardDesc.reverse();
      const sizes = day4GroupSizes(orderedPlayers.length);
      if (!sizes.length || sizes.reduce((sum, n) => sum + n, 0) !== orderedPlayers.length) {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=4&error=Unable%20to%20generate%20valid%20group%20sizes`);
      }

      const existingGroups = await db('tee_groups')
        .where({ event_id: eventId, day })
        .orderBy('group_number', 'asc')
        .select('id', 'group_number', 'tee_time', 'tee_location', 'starting_hole');

      const requiredGroupCount = sizes.length;
      const keepCount = Math.min(existingGroups.length, requiredGroupCount);
      const keptGroups = existingGroups.slice(0, keepCount);
      const removeGroups = existingGroups.slice(keepCount);

      const templates = [];
      const incrementMinutes = GENERATED_TEE_TIME_GAP_MINUTES;
      const baseTeeTime = String((keptGroups[0] && keptGroups[0].tee_time) || (existingGroups[0] && existingGroups[0].tee_time) || '10:00').slice(0, 5) || '10:00';
      for (let i = 0; i < requiredGroupCount; i += 1) {
        if (i < keptGroups.length) {
          const g = keptGroups[i];
          templates.push({
            group_number: i + 1,
            tee_time: addMinutesToTime(baseTeeTime, i * incrementMinutes),
            starting_hole: Number(g.starting_hole || 1),
            tee_location: null
          });
          continue;
        }

        const prev = templates[i - 1] || { tee_time: '07:00', starting_hole: 1, tee_location: null };
        const nextStartingHole = Number(prev.starting_hole || 1);
        templates.push({
          group_number: i + 1,
          tee_time: addMinutesToTime(baseTeeTime, i * incrementMinutes),
          starting_hole: nextStartingHole,
          tee_location: null
        });
      }

      await db.transaction(async (trx) => {
        const existingIds = existingGroups.map((g) => Number(g.id));
        if (existingIds.length) {
          await trx('tee_group_players').whereIn('tee_group_id', existingIds).del();
        }

        if (removeGroups.length) {
          await trx('tee_groups').whereIn('id', removeGroups.map((g) => Number(g.id))).del();
        }

        const finalGroupIds = [];
        for (let i = 0; i < requiredGroupCount; i += 1) {
          const t = templates[i];
          if (i < keptGroups.length) {
            const groupId = Number(keptGroups[i].id);
            await trx('tee_groups')
              .where({ id: groupId })
              .update({
                group_number: t.group_number,
                tee_time: t.tee_time,
                tee_location: t.tee_location,
                starting_hole: t.starting_hole,
                source: 'day4_leaderboard',
                updated_at: trx.fn.now()
              });
            finalGroupIds.push(groupId);
          } else {
            const ids = await trx('tee_groups').insert({
              event_id: eventId,
              day,
              tee_time: t.tee_time,
              tee_location: t.tee_location,
              starting_hole: t.starting_hole,
              group_number: t.group_number,
              source: 'day4_leaderboard'
            });
            finalGroupIds.push(Number(Array.isArray(ids) ? ids[0] : ids));
          }
        }

        let cursor = 0;
        for (let i = 0; i < finalGroupIds.length; i += 1) {
          const groupId = finalGroupIds[i];
          const size = sizes[i];
          const chunk = orderedPlayers.slice(cursor, cursor + size);
          cursor += size;

          for (let pos = 0; pos < chunk.length; pos += 1) {
            await trx('tee_group_players').insert({
              tee_group_id: groupId,
              user_id: Number(chunk[pos].id),
              position: pos + 1
            });
          }
        }
      });

      return res.redirect(`/admin/events/${eventId}/tee-times?day=4&message=Day%204%20groups%20generated%20from%20leaderboard`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/tee-times/day2/generate', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      const dayStatus = await getOrCreateDayStatus(db, eventId, 2);
      if (dayStatus.status !== 'draft') {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=2&error=Day%202%20must%20be%20draft%20to%20generate%20groups`);
      }

      await generateDay2GroupsFromCalcuttaDraw(db, eventId);
      return res.redirect(`/admin/events/${eventId}/tee-times?day=2&message=Day%202%20groups%20generated%20from%20Calcutta`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/tee-times/:groupId/players', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const groupId = Number(req.params.groupId);
      const day = parseIndividualDay(req.query.day, 2);
      const selected = Array.isArray(req.body.userIds) ? req.body.userIds : req.body.userIds ? [req.body.userIds] : [];
      const userIds = selected.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);

      const group = await db('tee_groups').where({ id: groupId, event_id: eventId }).first();
      if (!group) return res.redirect(`/admin/events/${eventId}/tee-times?day=${day}&error=Group%20not%20found`);
      const dayStatus = await getOrCreateDayStatus(db, eventId, group.day);
      if (dayStatus.status !== 'draft') {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&error=Day%20is%20not%20in%20draft`);
      }

      const validPlayers = await db('event_players')
        .where({ event_id: eventId })
        .whereIn('user_id', userIds)
        .select('user_id');
      const validIds = new Set(validPlayers.map((r) => r.user_id));
      let filteredIds = userIds.filter((id) => validIds.has(id));

      // Day 2 rule: if the defending champion is in the group, they must be listed first.
      if (Number(group.day) === 2 && filteredIds.length) {
        const defendingChampion = await db('event_players')
          .where({ event_id: eventId, is_previous_year_winner: 1 })
          .select('user_id')
          .first();
        const championId = Number(defendingChampion?.user_id || 0);
        if (championId && filteredIds.includes(championId)) {
          filteredIds = [championId, ...filteredIds.filter((id) => id !== championId)];
        }
      }

      await db('tee_group_players').where({ tee_group_id: groupId }).del();
      for (let i = 0; i < filteredIds.length; i += 1) {
        await db('tee_group_players').insert({
          tee_group_id: groupId,
          user_id: filteredIds[i],
          position: i + 1
        });
      }

      return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&message=Group%20players%20updated`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/tee-times/assign', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const day = parseIndividualDay(req.query.day, 2);
      const groupId = Number(req.body.groupId);
      const selected = Array.isArray(req.body.userIds) ? req.body.userIds : req.body.userIds ? [req.body.userIds] : [];
      const userIds = selected.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
      if (!userIds.length) {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=${day}&error=Select%20at%20least%20one%20player`);
      }

      const group = await db('tee_groups').where({ id: groupId, event_id: eventId }).first();
      if (!group) return res.redirect(`/admin/events/${eventId}/tee-times?day=${day}&error=Group%20not%20found`);

      const dayStatus = await getOrCreateDayStatus(db, eventId, group.day);
      if (dayStatus.status !== 'draft') {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&error=Day%20is%20not%20in%20draft`);
      }

      const validPlayers = await db('event_players')
        .where({ event_id: eventId })
        .whereIn('user_id', userIds)
        .select('user_id');
      const validIds = [...new Set(validPlayers.map((r) => Number(r.user_id)).filter((id) => Number.isInteger(id) && id > 0))];
      if (!validIds.length) {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&error=No%20valid%20players%20selected`);
      }

      const targetGroupIds = await db('tee_groups')
        .where({ event_id: eventId, day: group.day })
        .pluck('id');

      const impactedRows = await db('tee_group_players')
        .whereIn('tee_group_id', targetGroupIds)
        .whereIn('user_id', validIds)
        .select('tee_group_id');
      const impactedGroupIds = new Set(impactedRows.map((r) => Number(r.tee_group_id)));
      impactedGroupIds.add(Number(group.id));

      await db('tee_group_players')
        .whereIn('tee_group_id', targetGroupIds)
        .whereIn('user_id', validIds)
        .del();

      const existingRows = await db('tee_group_players')
        .where({ tee_group_id: group.id })
        .orderBy('position', 'asc')
        .orderBy('id', 'asc')
        .select('user_id');
      let orderedIds = existingRows.map((r) => Number(r.user_id));
      for (const uid of validIds) {
        if (!orderedIds.includes(uid)) orderedIds.push(uid);
      }

      if (Number(group.day) === 2 && orderedIds.length) {
        const defendingChampion = await db('event_players')
          .where({ event_id: eventId, is_previous_year_winner: 1 })
          .first('user_id');
        const championId = Number(defendingChampion?.user_id || 0);
        if (championId && orderedIds.includes(championId)) {
          orderedIds = [championId, ...orderedIds.filter((id) => id !== championId)];
        }
      }

      await db('tee_group_players').where({ tee_group_id: group.id }).del();
      for (let i = 0; i < orderedIds.length; i += 1) {
        await db('tee_group_players').insert({
          tee_group_id: group.id,
          user_id: orderedIds[i],
          position: i + 1
        });
      }

      for (const impactedGroupId of impactedGroupIds) {
        if (Number(impactedGroupId) === Number(group.id)) continue;
        const rows = await db('tee_group_players')
          .where({ tee_group_id: impactedGroupId })
          .orderBy('position', 'asc')
          .orderBy('id', 'asc')
          .select('id');
        for (let i = 0; i < rows.length; i += 1) {
          await db('tee_group_players')
            .where({ id: Number(rows[i].id) })
            .update({ position: i + 1, updated_at: db.fn.now() });
        }
      }

      return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&message=Players%20assigned%20to%20group`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/tee-times/:groupId/players/:userId/remove', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const groupId = Number(req.params.groupId);
      const userId = Number(req.params.userId);
      const day = parseIndividualDay(req.query.day, 2);

      const group = await db('tee_groups').where({ id: groupId, event_id: eventId }).first();
      if (!group) return res.redirect(`/admin/events/${eventId}/tee-times?day=${day}&error=Group%20not%20found`);

      const dayStatus = await getOrCreateDayStatus(db, eventId, group.day);
      if (dayStatus.status !== 'draft') {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&error=Day%20is%20not%20in%20draft`);
      }

      await db('tee_group_players').where({ tee_group_id: group.id, user_id: userId }).del();
      const rows = await db('tee_group_players')
        .where({ tee_group_id: group.id })
        .orderBy('position', 'asc')
        .orderBy('id', 'asc')
        .select('id');
      for (let i = 0; i < rows.length; i += 1) {
        await db('tee_group_players')
          .where({ id: Number(rows[i].id) })
          .update({ position: i + 1, updated_at: db.fn.now() });
      }

      return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&message=Player%20removed%20from%20group`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/tee-times/:groupId/delete', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const groupId = Number(req.params.groupId);
      const fallbackDay = parseIndividualDay(req.query.day, 2);

      const group = await db('tee_groups').where({ id: groupId, event_id: eventId }).first();
      if (!group) return res.redirect(`/admin/events/${eventId}/tee-times?day=${fallbackDay}&error=Group%20not%20found`);

      const dayStatus = await getOrCreateDayStatus(db, eventId, group.day);
      if (dayStatus.status !== 'draft') {
        return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&error=Cannot%20delete%20groups%20after%20scoring%20opens`);
      }

      await db('tee_groups').where({ id: groupId }).del();
      await normalizeTeeGroupsForDay(db, eventId, group.day);
      return res.redirect(`/admin/events/${eventId}/tee-times?day=${group.day}&message=Group%20deleted`);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/events/:id/ambrose', requireAuth, requireRole([ROLES.ADMIN]), async (req, res) => {
    const eventId = Number(req.params.id);
    const event = await db('events').where({ id: eventId }).first();
    if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

    const eventPlayers = await db('event_players as ep')
      .join('users as u', 'u.id', 'ep.user_id')
      .leftJoin('player_handicaps as ph', function joinPh() {
        this.on('ph.user_id', '=', 'u.id').andOn('ph.event_id', '=', 'ep.event_id');
      })
      .where('ep.event_id', eventId)
      .select('u.id', 'u.first_name', 'u.last_name', 'u.is_previous_winner', 'ph.playing_handicap')
      .orderBy('u.last_name', 'asc');
    const eventPlayersWithHcp = eventPlayers.map((p) => ({ ...p, handicap_display: formatHandicapDisplay(p.playing_handicap) }));

    const groups = await db('ambrose_groups')
      .where({ event_id: eventId, day: 1 })
      .orderBy('group_number', 'asc')
      .select('id', 'group_number', 'tee_time', 'tee_location', 'starting_hole');

    const teams = await db('teams as t')
      .leftJoin('ambrose_groups as ag', 'ag.id', 't.ambrose_group_id')
      .where({ 't.event_id': eventId, 't.day': 1, 't.competition_type': 'ambrose' })
      .orderBy('t.name', 'asc')
      .select(
        't.id',
        't.name',
        't.ambrose_group_id',
        'ag.group_number',
        'ag.tee_time',
        'ag.tee_location',
        'ag.starting_hole'
      );
    const dayStatus = await getOrCreateDayStatus(db, eventId, 1);

    const teamMembers = new Map();
    if (teams.length) {
      const teamIds = teams.map((t) => t.id);
      const members = await db('team_members as tm')
        .join('users as u', 'u.id', 'tm.user_id')
        .leftJoin('player_handicaps as ph', function joinPh() {
          this.on('ph.user_id', '=', 'u.id').andOnVal('ph.event_id', '=', eventId);
        })
        .whereIn('tm.team_id', teamIds)
        .orderBy('u.last_name', 'asc')
        .select('tm.team_id', 'u.id', 'u.first_name', 'u.last_name', 'u.is_previous_winner', 'ph.playing_handicap');

      for (const row of members) {
        if (!teamMembers.has(row.team_id)) teamMembers.set(row.team_id, []);
        teamMembers.get(row.team_id).push({ ...row, handicap_display: formatHandicapDisplay(row.playing_handicap) });
      }
    }

    const teamExactHandicaps = new Map();
    for (const team of teams) {
      const members = teamMembers.get(Number(team.id)) || [];
      const allowance = ambroseAllowance(members.length);
      const raw = members.reduce((sum, m) => sum + Number(m.playing_handicap || 0), 0) * allowance;
      teamExactHandicaps.set(Number(team.id), formatAmbroseExactHandicap(raw, allowance));
    }

    const message = req.query.message ? String(req.query.message) : null;
    const error = req.query.error ? String(req.query.error) : null;
    const dayScoreCount = await countRecordedScoresForDay(db, eventId, 1);
    const dayFinalization = await getDayFinalizationSummary(db, eventId, 1);
    const teamSummaries = dayFinalization.isFinalized
      ? await getTeamScoreSummariesForDay(db, eventId, 1, teams.map((t) => Number(t.id)))
      : new Map();
    const [noveltyEvents, noveltyOptions] = await Promise.all([
      getNoveltyEventsForDayWithResults(db, eventId, 1),
      getNoveltySelectionOptionsForDay(db, eventId, 1)
    ]);

    return res.render('admin/ambrose-teams', {
      title: 'Ambrose Teams',
      user: req.session.user,
      event,
      eventPlayers: eventPlayersWithHcp,
      teams,
      groups,
      dayStatus,
      dayScoreCount,
      dayFinalization,
      noveltyEvents,
      noveltyOptions,
      teamMembers,
      teamExactHandicaps,
      teamSummaries,
      message,
      error
    });
  });

  router.post('/events/:id/ambrose/groups', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const dayStatus = await getOrCreateDayStatus(db, eventId, 1);
      if (dayStatus.status !== 'draft') {
        return res.redirect(`/admin/events/${eventId}/ambrose?error=Day%201%20is%20not%20in%20draft`);
      }

      const groupNumber = Number(req.body.groupNumber);
      const teeTime = String(req.body.teeTime || '').trim();
      const startingHole = Number(req.body.startingHole || 1);

      if (!Number.isInteger(groupNumber) || groupNumber < 1) {
        return res.redirect(`/admin/events/${eventId}/ambrose?error=Group%20number%20is%20required`);
      }
      if (!teeTime) return res.redirect(`/admin/events/${eventId}/ambrose?error=Tee%20time%20is%20required`);
      if (!Number.isInteger(startingHole) || startingHole < 1 || startingHole > 18) {
        return res.redirect(`/admin/events/${eventId}/ambrose?error=Starting%20hole%20must%20be%201%20to%2018`);
      }

      const duplicate = await db('ambrose_groups').where({ event_id: eventId, day: 1, group_number: groupNumber }).first();
      if (duplicate) return res.redirect(`/admin/events/${eventId}/ambrose?error=Group%20number%20already%20exists`);

      await db('ambrose_groups').insert({
        event_id: eventId,
        day: 1,
        group_number: groupNumber,
        tee_time: teeTime,
        tee_location: null,
        starting_hole: startingHole
      });

      return res.redirect(`/admin/events/${eventId}/ambrose?message=Ambrose%20group%20created`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/ambrose/teams', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const teamName = String(req.body.teamName || '').trim();
      const ambroseGroupId = Number(req.body.ambroseGroupId);
      const selected = Array.isArray(req.body.userIds) ? req.body.userIds : req.body.userIds ? [req.body.userIds] : [];
      const userIds = selected.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);

      const dayStatus = await getOrCreateDayStatus(db, eventId, 1);
      if (dayStatus.status !== 'draft') {
        return res.redirect(`/admin/events/${eventId}/ambrose?error=Day%201%20is%20not%20in%20draft`);
      }

      if (!teamName) return res.redirect(`/admin/events/${eventId}/ambrose?error=Team%20name%20is%20required`);
      if (!Number.isInteger(ambroseGroupId) || ambroseGroupId <= 0) return res.redirect(`/admin/events/${eventId}/ambrose?error=Select%20an%20Ambrose%20group`);
      if (userIds.length < 2 || userIds.length > 3) {
        return res.redirect(`/admin/events/${eventId}/ambrose?error=Ambrose%20team%20must%20have%202%20or%203%20players`);
      }

      const group = await db('ambrose_groups').where({ id: ambroseGroupId, event_id: eventId, day: 1 }).first();
      if (!group) return res.redirect(`/admin/events/${eventId}/ambrose?error=Selected%20group%20not%20found`);
      const [countRow] = await db('teams')
        .where({ event_id: eventId, day: 1, competition_type: 'ambrose', ambrose_group_id: ambroseGroupId })
        .count({ total: '*' });
      if (Number(countRow.total || 0) >= 2) {
        return res.redirect(`/admin/events/${eventId}/ambrose?error=Group%20already%20has%202%20teams`);
      }
      const existingByName = await db('teams').where({
        event_id: eventId,
        day: 1,
        competition_type: 'ambrose',
        ambrose_group_id: ambroseGroupId,
        name: teamName
      }).first();
      if (existingByName) {
        return res.redirect(`/admin/events/${eventId}/ambrose?error=A%20team%20with%20that%20name%20already%20exists%20in%20this%20group`);
      }

      const validPlayers = await db('event_players')
        .where({ event_id: eventId })
        .whereIn('user_id', userIds)
        .select('user_id');
      if (validPlayers.length !== userIds.length) {
        return res.redirect(`/admin/events/${eventId}/ambrose?error=One%20or%20more%20players%20are%20not%20in%20this%20event`);
      }

      await db.transaction(async (trx) => {
        const ids = await trx('teams').insert({
          event_id: eventId,
          day: 1,
          competition_type: 'ambrose',
          name: teamName,
          ambrose_group_id: ambroseGroupId
        });
        const teamId = Array.isArray(ids) ? ids[0] : ids;

        for (const userId of userIds) {
          await trx('team_members').insert({
            team_id: teamId,
            user_id: userId,
            is_dual_assigned: false
          });
        }
      });

      return res.redirect(`/admin/events/${eventId}/ambrose?message=Ambrose%20team%20created`);
    } catch (error) {
      if (
        error?.code === 'SQLITE_CONSTRAINT' ||
        String(error.message || '').includes('ux_ambrose_team_name_in_group') ||
        String(error.message || '').toLowerCase().includes('unique constraint failed')
      ) {
        return res.redirect(`/admin/events/${req.params.id}/ambrose?error=A%20team%20with%20that%20name%20already%20exists%20in%20this%20group`);
      }
      return next(error);
    }
  });

  router.post('/events/:id/ambrose/teams/:teamId/delete', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const teamId = Number(req.params.teamId);

      const dayStatus = await getOrCreateDayStatus(db, eventId, 1);
      if (dayStatus.status !== 'draft') {
        return res.redirect(`/admin/events/${eventId}/ambrose?error=Cannot%20delete%20teams%20after%20scoring%20opens`);
      }

      const team = await db('teams').where({ id: teamId, event_id: eventId, day: 1, competition_type: 'ambrose' }).first();
      if (!team) return res.redirect(`/admin/events/${eventId}/ambrose?error=Team%20not%20found`);

      await db('scorecards').where({ event_id: eventId, day: 1, type: 'team', team_id: teamId }).del();
      await db('teams').where({ id: teamId }).del();
      return res.redirect(`/admin/events/${eventId}/ambrose?message=Team%20deleted`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/ambrose/scorecards', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const dayStatus = await getOrCreateDayStatus(db, eventId, 1);
      if (dayStatus.status !== 'draft') {
        return res.redirect(`/admin/events/${eventId}/ambrose?error=Day%201%20is%20not%20in%20draft`);
      }
      const teams = await db('teams')
        .where({ event_id: eventId, day: 1, competition_type: 'ambrose' })
        .select('id');

      for (const team of teams) {
        const existing = await db('scorecards')
          .where({ event_id: eventId, day: 1, type: 'team', team_id: team.id })
          .first();
        if (!existing) {
          await db('scorecards').insert({
            event_id: eventId,
            day: 1,
            type: 'team',
            team_id: team.id,
            status: 'draft'
          });
        }
      }

      return res.redirect(`/admin/events/${eventId}/ambrose?message=Ambrose%20team%20scorecards%20ready`);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/events/:id/scorecards/individual/:scorecardId', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const scorecardId = Number(req.params.scorecardId);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      const scorecard = await db('scorecards')
        .where({ id: scorecardId, event_id: eventId, type: 'individual' })
        .first();
      if (!scorecard) return res.redirect(`/admin/events/${eventId}?error=Scorecard%20not%20found`);

      const model = await buildIndividualAdminScorecardModel(db, event, scorecard);
      if (!model) {
        const backUrl = `/admin/events/${eventId}/tee-times?day=${Number(scorecard.day || 2)}`;
        return res.redirect(`${backUrl}&error=Unable%20to%20build%20scorecard`);
      }

      const defaultBack = `/admin/events/${eventId}/tee-times?day=${Number(scorecard.day || 2)}`;
      const backUrl = sanitizeAdminReturnTo(eventId, req.query.returnTo, defaultBack);
      const message = req.query.message ? String(req.query.message) : null;
      const error = req.query.error ? String(req.query.error) : null;
      const editLogs = await getScorecardEditLogs(db, scorecard.id);
      return res.render('admin/scorecard-review', {
        title: `${model.title} · ${model.dayLabel} Scorecard`,
        user: req.session.user,
        event,
        model,
        scorecard,
        backUrl,
        canEdit: model.canEdit,
        editLogs,
        message,
        error
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/events/:id/scorecards/team/:scorecardId', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const scorecardId = Number(req.params.scorecardId);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      const scorecard = await db('scorecards')
        .where({ id: scorecardId, event_id: eventId, type: 'team' })
        .first();
      if (!scorecard) return res.redirect(`/admin/events/${eventId}/ambrose?error=Scorecard%20not%20found`);

      const model = await buildTeamAdminScorecardModel(db, event, scorecard);
      if (!model) return res.redirect(`/admin/events/${eventId}/ambrose?error=Unable%20to%20build%20scorecard`);

      const defaultBack = `/admin/events/${eventId}/ambrose`;
      const backUrl = sanitizeAdminReturnTo(eventId, req.query.returnTo, defaultBack);
      const message = req.query.message ? String(req.query.message) : null;
      const error = req.query.error ? String(req.query.error) : null;
      const editLogs = await getScorecardEditLogs(db, scorecard.id);
      return res.render('admin/scorecard-review', {
        title: `${model.title} · ${model.dayLabel} Scorecard`,
        user: req.session.user,
        event,
        model,
        scorecard,
        backUrl,
        canEdit: model.canEdit,
        editLogs,
        message,
        error
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/scorecards/:scorecardId/holes/:holeNumber', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const scorecardId = Number(req.params.scorecardId);
      const holeNumber = Number(req.params.holeNumber);
      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      const scorecard = await db('scorecards').where({ id: scorecardId, event_id: eventId }).first();
      if (!scorecard) return res.redirect(`/admin/events/${eventId}?error=Scorecard%20not%20found`);

      const reviewPath = scorecard.type === 'team'
        ? `/admin/events/${eventId}/scorecards/team/${scorecardId}`
        : `/admin/events/${eventId}/scorecards/individual/${scorecardId}`;
      const returnTo = sanitizeAdminReturnTo(
        eventId,
        req.body.returnTo,
        scorecard.type === 'team' ? `/admin/events/${eventId}/ambrose` : `/admin/events/${eventId}/tee-times?day=${Number(scorecard.day || 2)}`
      );

      if (!Number.isInteger(holeNumber) || holeNumber < 1 || holeNumber > 18) {
        return res.redirect(`${reviewPath}?returnTo=${encodeURIComponent(returnTo)}&error=Invalid%20hole`);
      }

      const dayStatus = await getOrCreateDayStatus(db, eventId, Number(scorecard.day));
      if (Number(dayStatus.leaderboard_published || 0) === 1) {
        return res.redirect(`${reviewPath}?returnTo=${encodeURIComponent(returnTo)}&error=Day%20is%20published.%20Unpublish%20before%20editing`);
      }

      const holeConfig = await getHoleConfigForEventDay(db, eventId, Number(scorecard.day), holeNumber);
      if (!holeConfig) {
        return res.redirect(`${reviewPath}?returnTo=${encodeURIComponent(returnTo)}&error=Hole%20configuration%20not%20found`);
      }

      const grossInput = String(req.body.grossScore || '').trim();
      const grossNumber = grossInput === '' ? 0 : Number(grossInput);
      const grossScore = Number.isFinite(grossNumber) ? Math.trunc(grossNumber) : NaN;
      if (grossInput !== '' && (!Number.isInteger(grossScore) || grossScore < 1 || grossScore > 25)) {
        return res.redirect(`${reviewPath}?returnTo=${encodeURIComponent(returnTo)}&error=Gross%20score%20must%20be%201-25%20or%20blank%20to%20clear`);
      }

      let playingHandicap = 0;
      if (scorecard.type === 'individual') {
        const handicap = await db('player_handicaps')
          .where({ event_id: eventId, user_id: scorecard.user_id })
          .first();
        playingHandicap = Math.trunc(Number(handicap?.playing_handicap || 0));
      } else if (scorecard.type === 'team') {
        const teamHandicap = await getTeamHandicapInfo(db, eventId, scorecard.team_id);
        playingHandicap = Number(teamHandicap.wholeShots || 0);
      } else {
        return res.redirect(`${reviewPath}?returnTo=${encodeURIComponent(returnTo)}&error=Unsupported%20scorecard%20type`);
      }

      const existing = await db('scorecard_holes').where({ scorecard_id: scorecardId, hole_number: holeNumber }).first();
      const previousGross = existing && existing.gross_score != null ? Number(existing.gross_score) : null;
      const previousStableford = existing && existing.stableford_points != null ? Number(existing.stableford_points) : null;
      let newGross = null;
      let newStableford = null;
      let changed = false;

      if (grossInput === '') {
        if (existing) {
          await db('scorecard_holes').where({ id: Number(existing.id) }).del();
          changed = true;
        }
      } else {
        const calc = stablefordPoints({
          grossScore,
          par: Number(holeConfig.par),
          strokeIndexPrimary: Number(holeConfig.stroke_index_primary),
          strokeIndexSecondary: Number(holeConfig.stroke_index_secondary),
          playingHandicap
        });
        newGross = grossScore;
        newStableford = Number(calc.points);

        changed = !existing
          || Number(existing.gross_score) !== grossScore
          || Number(existing.stableford_points || 0) !== Number(calc.points || 0);

        if (existing) {
          await db('scorecard_holes')
            .where({ id: Number(existing.id) })
            .update({
              gross_score: grossScore,
              stableford_points: calc.points,
              owner_user_id: Number(req.session.user?.id || 0) || null,
              updated_at: db.fn.now()
            });
        } else {
          await db('scorecard_holes').insert({
            scorecard_id: scorecardId,
            hole_number: holeNumber,
            gross_score: grossScore,
            stableford_points: calc.points,
            owner_user_id: Number(req.session.user?.id || 0) || null
          });
        }
      }

      if (!changed) {
        return res.redirect(`${reviewPath}?returnTo=${encodeURIComponent(returnTo)}&message=No%20score%20change%20detected`);
      }

      await db('scorecard_edit_logs').insert({
        scorecard_id: scorecardId,
        hole_number: holeNumber,
        previous_gross_score: previousGross,
        previous_stableford_points: previousStableford,
        new_gross_score: newGross,
        new_stableford_points: newStableford,
        editor_user_id: Number(req.session.user?.id || 0) || null
      });

      await markLeaderboardDirty(db, eventId);
      return res.redirect(`${reviewPath}?returnTo=${encodeURIComponent(returnTo)}&message=Hole%20${holeNumber}%20updated.%20Leaderboards%20marked%20for%20refresh`);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/courses/:courseId(\\d+)', requireAuth, requireRole([ROLES.ADMIN]), async (req, res) => {
    const courseId = Number(req.params.courseId);
    const course = await db('courses').where({ id: courseId }).first();
    if (!course) return res.redirect('/admin/courses?error=Course%20not%20found');

    const holes = await db('holes')
      .where({ course_id: courseId })
      .orderBy('hole_number', 'asc')
      .select('id', 'hole_number', 'par', 'length_meters', 'stroke_index_primary', 'stroke_index_secondary');
    const courseEditLocked = await isGlobalCourseEditingLocked(db, courseId);

    const message = req.query.message ? String(req.query.message) : null;
    const error = req.query.error ? String(req.query.error) : null;

    return res.render('admin/course-edit', {
      title: `Edit Course ${course.tee_name}`,
      user: req.session.user,
      course,
      holes,
      courseEditLocked,
      message,
      error
    });
  });

  router.post('/courses/:courseId(\\d+)', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const courseId = Number(req.params.courseId);
      const course = await db('courses').where({ id: courseId }).first();
      if (!course) return res.redirect('/admin/courses?error=Course%20not%20found');

      const locked = await isGlobalCourseEditingLocked(db, courseId);
      if (locked) {
        return res.redirect(`/admin/courses/${courseId}?error=Course%20editing%20is%20locked%20for%20active%20events%20with%20scores`);
      }

      const courseName = String(req.body.courseName || '').trim();
      const teeName = String(req.body.teeName || '').trim();
      if (!courseName || !teeName) {
        return res.redirect(`/admin/courses/${courseId}?error=Course%20name%20and%20tee%20name%20are%20required`);
      }

      const duplicateCourse = await db('courses')
        .whereRaw('LOWER(course_name) = ?', [courseName.toLowerCase()])
        .andWhereRaw('LOWER(tee_name) = ?', [teeName.toLowerCase()])
        .andWhereNot({ id: courseId })
        .first();
      if (duplicateCourse) {
        return res.redirect(`/admin/courses/${courseId}?error=Another%20course%20already%20uses%20that%20name%20and%20tee`);
      }

      await db('courses').where({ id: courseId }).update({
        course_name: courseName,
        tee_name: teeName,
        updated_at: db.fn.now()
      });

      const holeRows = await db('holes').where({ course_id: courseId }).select('id', 'hole_number');
      for (const hole of holeRows) {
        const par = Number(req.body[`par_${hole.id}`]);
        const meters = Number(req.body[`meters_${hole.id}`]);
        const primary = Number(req.body[`si_primary_${hole.id}`]);
        const secondary = Number(req.body[`si_secondary_${hole.id}`]);

        if (!Number.isFinite(par) || par < 3 || par > 5) {
          return res.redirect(`/admin/courses/${courseId}?error=Invalid%20par%20for%20hole%20${hole.hole_number}`);
        }
        if (!Number.isFinite(primary) || primary < 1 || primary > 18) {
          return res.redirect(`/admin/courses/${courseId}?error=Invalid%20primary%20SI%20for%20hole%20${hole.hole_number}`);
        }
        if (!Number.isFinite(secondary) || secondary < 19 || secondary > 36) {
          return res.redirect(`/admin/courses/${courseId}?error=Invalid%20secondary%20SI%20for%20hole%20${hole.hole_number}`);
        }
        if (!Number.isFinite(meters) || meters < 50 || meters > 700) {
          return res.redirect(`/admin/courses/${courseId}?error=Invalid%20meters%20for%20hole%20${hole.hole_number}`);
        }

        await db('holes').where({ id: hole.id }).update({
          par,
          length_meters: meters,
          stroke_index_primary: primary,
          stroke_index_secondary: secondary,
          updated_at: db.fn.now()
        });
      }

      return res.redirect(`/admin/courses/${courseId}?message=Course%20updated`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/players', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const userId = Number(req.body.userId);
      if (!Number.isInteger(eventId) || !Number.isInteger(userId)) {
        return res.redirect(`/admin/events/${eventId}?error=Invalid%20player%20selection`);
      }

      const hasAnyScores = await hasRecordedScoresForEvent(db, eventId);
      if (hasAnyScores) {
        return res.redirect(`/admin/events/${eventId}?error=Player%20changes%20are%20locked%20after%20scores%20are%20entered`);
      }

      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/admin/dashboard?error=Event%20not%20found');

      const exists = await db('event_players').where({ event_id: eventId, user_id: userId }).first();
      if (exists) return res.redirect(`/admin/events/${eventId}?error=Player%20already%20in%20event`);

      await db('event_players').insert({ event_id: eventId, user_id: userId, status: 'active' });
      return res.redirect(`/admin/events/${eventId}?message=Player%20added%20to%20event`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/players/:userId/handicap', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const userId = Number(req.params.userId);
      const hasAnyScores = await hasRecordedScoresForEvent(db, eventId);
      if (hasAnyScores) {
        return res.redirect(`/admin/events/${eventId}?error=Player%20changes%20are%20locked%20after%20scores%20are%20entered`);
      }
      const playingHandicap = Number(req.body.playingHandicap);
      const isPreviousYearWinner = parseCheckbox(req.body.isPreviousYearWinner);
      if (!Number.isInteger(playingHandicap) || playingHandicap < -10 || playingHandicap > 54) {
        return res.redirect(`/admin/events/${eventId}?error=Handicap%20must%20be%20a%20whole%20number%20between%20-10%20and%2054`);
      }

      const inEvent = await db('event_players').where({ event_id: eventId, user_id: userId }).first();
      if (!inEvent) return res.redirect(`/admin/events/${eventId}?error=Player%20must%20be%20in%20event`);

      const existing = await db('player_handicaps').where({ event_id: eventId, user_id: userId }).first();
      if (existing) {
        await db('player_handicaps')
          .where({ id: existing.id })
          .update({ playing_handicap: playingHandicap, updated_at: db.fn.now() });
      } else {
        await db('player_handicaps').insert({
          event_id: eventId,
          user_id: userId,
          playing_handicap: playingHandicap
        });
      }

      if (isPreviousYearWinner) {
        await db('event_players')
          .where({ event_id: eventId })
          .update({ is_previous_year_winner: 0, updated_at: db.fn.now() });
      }
      await db('event_players')
        .where({ event_id: eventId, user_id: userId })
        .update({ is_previous_year_winner: isPreviousYearWinner, updated_at: db.fn.now() });

      return res.redirect(`/admin/events/${eventId}?message=Handicap%20updated`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/players/:userId/update', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const userId = Number(req.params.userId);
      const hasAnyScores = await hasRecordedScoresForEvent(db, eventId);
      if (hasAnyScores) {
        return res.redirect(`/admin/events/${eventId}?error=Player%20changes%20are%20locked%20after%20scores%20are%20entered`);
      }

      const playingHandicap = Number(req.body.playingHandicap);
      const isPreviousYearWinner = parseCheckbox(req.body.isPreviousYearWinner);
      if (!Number.isInteger(playingHandicap) || playingHandicap < -10 || playingHandicap > 54) {
        return res.redirect(`/admin/events/${eventId}?error=Handicap%20must%20be%20a%20whole%20number%20between%20-10%20and%2054`);
      }

      const inEvent = await db('event_players').where({ event_id: eventId, user_id: userId }).first();
      if (!inEvent) return res.redirect(`/admin/events/${eventId}?error=Player%20must%20be%20in%20event`);

      const existing = await db('player_handicaps').where({ event_id: eventId, user_id: userId }).first();
      if (existing) {
        await db('player_handicaps')
          .where({ id: existing.id })
          .update({ playing_handicap: playingHandicap, updated_at: db.fn.now() });
      } else {
        await db('player_handicaps').insert({
          event_id: eventId,
          user_id: userId,
          playing_handicap: playingHandicap
        });
      }

      if (isPreviousYearWinner) {
        await db('event_players')
          .where({ event_id: eventId })
          .update({ is_previous_year_winner: 0, updated_at: db.fn.now() });
      }
      await db('event_players')
        .where({ event_id: eventId, user_id: userId })
        .update({ is_previous_year_winner: isPreviousYearWinner, updated_at: db.fn.now() });

      return res.redirect(`/admin/events/${eventId}?message=Player%20updated`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events/:id/players/:userId/delete', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const eventId = Number(req.params.id);
      const userId = Number(req.params.userId);
      const hasAnyScores = await hasRecordedScoresForEvent(db, eventId);
      if (hasAnyScores) {
        return res.redirect(`/admin/events/${eventId}?error=Player%20deletes%20are%20locked%20after%20scores%20are%20entered`);
      }

      const inEvent = await db('event_players').where({ event_id: eventId, user_id: userId }).first();
      if (!inEvent) return res.redirect(`/admin/events/${eventId}?error=Player%20must%20be%20in%20event`);

      const teamIds = await db('team_members as tm')
        .join('teams as t', 't.id', 'tm.team_id')
        .where({ 't.event_id': eventId, 'tm.user_id': userId })
        .pluck('tm.team_id');

      await db('tee_group_players')
        .where('user_id', userId)
        .whereIn('tee_group_id', db('tee_groups').where({ event_id: eventId }).select('id'))
        .del();

      if (teamIds.length) {
        await db('team_members').where({ user_id: userId }).whereIn('team_id', teamIds).del();

        const emptyTeamRows = await db('teams as t')
          .leftJoin('team_members as tm', 'tm.team_id', 't.id')
          .where('t.event_id', eventId)
          .whereIn('t.id', teamIds)
          .groupBy('t.id')
          .havingRaw('COUNT(tm.id) = 0')
          .select('t.id');
        const emptyTeamIds = emptyTeamRows.map((row) => Number(row.id));
        if (emptyTeamIds.length) {
          await db('scorecards').where({ event_id: eventId, type: 'team' }).whereIn('team_id', emptyTeamIds).del();
          await db('teams').whereIn('id', emptyTeamIds).del();
        }
      }

      const individualScorecardIds = await db('scorecards')
        .where({ event_id: eventId, type: 'individual', user_id: userId })
        .pluck('id');
      if (individualScorecardIds.length) {
        await db('scorecard_holes').whereIn('scorecard_id', individualScorecardIds).del();
      }
      await db('scorecards').where({ event_id: eventId, type: 'individual', user_id: userId }).del();
      await db('player_handicaps').where({ event_id: eventId, user_id: userId }).del();
      await db('event_players').where({ event_id: eventId, user_id: userId }).del();

      return res.redirect(`/admin/events/${eventId}?message=Player%20removed%20from%20event`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/courses/seed-white', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      let course = await db('courses')
        .where({ course_name: 'Bonville International Golf Resort', tee_name: 'Bloodwood' })
        .first();

      if (!course) {
        const ids = await db('courses').insert({
          course_name: 'Bonville International Golf Resort',
          tee_name: 'Bloodwood'
        });
        const courseId = Array.isArray(ids) ? ids[0] : ids;
        course = await db('courses').where({ id: courseId }).first();
      }

      for (const hole of BONVILLE_WHITE_HOLES) {
        const existingHole = await db('holes').where({ course_id: course.id, hole_number: hole.hole }).first();
        const row = {
          course_id: course.id,
          hole_number: hole.hole,
          par: hole.par,
          length_meters: hole.meters,
          stroke_index_primary: hole.si,
          stroke_index_secondary: hole.si + 18
        };

        if (existingHole) {
          await db('holes').where({ id: existingHole.id }).update({ ...row, updated_at: db.fn.now() });
        } else {
          await db('holes').insert(row);
        }
      }

      return res.redirect('/admin/courses?message=Bonville%20Bloodwood%20course%20ready');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/players', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const firstName = String(req.body.firstName || '').trim();
      const lastName = String(req.body.lastName || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();
      const phoneNumber = normalizeMobile(req.body.phoneNumber);
      const role = String(req.body.role || '').trim();
      const isPreviousWinner = parseCheckbox(req.body.isPreviousWinner);

      if (!firstName || !lastName || !email) {
        return res.redirect('/admin/players?error=First%20name%2C%20last%20name%2C%20and%20email%20are%20required');
      }
      if (!ALLOWED_ROLES.includes(role)) {
        return res.redirect('/admin/players?error=Invalid%20role');
      }

      const existing = await db('users').where({ email }).first();
      if (existing) {
        return res.redirect('/admin/players?error=A%20user%20with%20that%20email%20already%20exists');
      }
      if (phoneNumber) {
        const existingMobile = await db('users').where({ phone_number: phoneNumber }).first();
        if (existingMobile) {
          return res.redirect('/admin/players?error=A%20user%20with%20that%20mobile%20already%20exists');
        }
      }

      await db('users').insert({
        first_name: firstName,
        last_name: lastName,
        email,
        phone_number: phoneNumber,
        role,
        is_previous_winner: isPreviousWinner
      });

      return res.redirect('/admin/players?message=Player%20created');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/players/:id', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const userId = Number(req.params.id);
      const firstName = String(req.body.firstName || '').trim();
      const lastName = String(req.body.lastName || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();
      const phoneNumber = normalizeMobile(req.body.phoneNumber);
      const role = String(req.body.role || '').trim();
      const isPreviousWinner = parseCheckbox(req.body.isPreviousWinner);

      if (!Number.isInteger(userId) || userId <= 0) {
        return res.redirect('/admin/players?error=Invalid%20user%20id');
      }
      if (!firstName || !lastName || !email) {
        return res.redirect('/admin/players?error=First%20name%2C%20last%20name%2C%20and%20email%20are%20required');
      }
      if (!ALLOWED_ROLES.includes(role)) {
        return res.redirect('/admin/players?error=Invalid%20role');
      }

      const existingUser = await db('users').where({ id: userId }).first();
      if (!existingUser) {
        return res.redirect('/admin/players?error=User%20not%20found');
      }

      const existingEmail = await db('users').where({ email }).andWhereNot({ id: userId }).first();
      if (existingEmail) {
        return res.redirect('/admin/players?error=Email%20is%20already%20used%20by%20another%20user');
      }
      if (phoneNumber) {
        const existingMobile = await db('users')
          .where({ phone_number: phoneNumber })
          .andWhereNot({ id: userId })
          .first();
        if (existingMobile) {
          return res.redirect('/admin/players?error=Mobile%20is%20already%20used%20by%20another%20user');
        }
      }

      await db('users').where({ id: userId }).update({
        first_name: firstName,
        last_name: lastName,
        email,
        phone_number: phoneNumber,
        role,
        is_previous_winner: isPreviousWinner,
        updated_at: db.fn.now()
      });

      return res.redirect('/admin/players?message=Player%20updated');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/events', requireAuth, requireRole([ROLES.ADMIN]), async (req, res, next) => {
    try {
      const year = Number(req.body.year);
      const location = String(req.body.location || '').trim();
      const startDate = String(req.body.startDate || '').trim();
      const endDate = String(req.body.endDate || '').trim();
      const isActive = req.body.isActive === 'on' ? 1 : 0;

      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return res.redirect('/admin/dashboard?error=Invalid%20year');
      }
      if (!location || !startDate || !endDate) {
        return res.redirect('/admin/dashboard?error=All%20event%20fields%20are%20required');
      }
      if (startDate > endDate) {
        return res.redirect('/admin/dashboard?error=Start%20date%20must%20be%20before%20end%20date');
      }

      const existingYear = await db('events').where({ year }).first();
      if (existingYear) {
        return res.redirect('/admin/dashboard?error=An%20event%20for%20that%20year%20already%20exists');
      }

      if (isActive) {
        await db('events').update({ is_active: 0, updated_at: db.fn.now() });
      }

      const defaultCourse = await db('courses').orderBy('id', 'asc').first();
      if (!defaultCourse) {
        return res.redirect('/admin/dashboard?error=Create%20a%20course%20before%20creating%20an%20event');
      }

      const ids = await db('events').insert({
        year,
        location,
        start_date: startDate,
        end_date: endDate,
        is_active: isActive
      });
      const eventId = Number(Array.isArray(ids) ? ids[0] : ids);
      for (const day of [1, 2, 3, 4]) {
        await db('event_day_statuses').insert({
          event_id: eventId,
          day,
          status: 'draft',
          calc_type: defaultCalcTypeForDay(day),
          leaderboard_published: 0,
          course_id: Number(defaultCourse.id)
        });
      }

      return res.redirect('/admin/dashboard?message=Event%20created');
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { adminRouter };
