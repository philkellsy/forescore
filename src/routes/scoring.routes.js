'use strict';

const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { defaultCalcTypeForDay } = require('../config/calc-types');
const { canEditAllScores } = require('../services/permissions/scoring-permissions.service');
const { upsertHoleScore, ScoreConflictError } = require('../services/scoring/score-entry.service');
const { stablefordPoints } = require('../services/scoring/stableford.service');
const { markLeaderboardDirty } = require('../services/leaderboard/dirty.service');
const { dayLabel } = require('../services/events/day-label.service');
const { computeCourseHandicap, getCachedCourseData, getCachedParByHole, warmRoundCourseCache, isRoundCacheWarm } = require('../services/scoring/handicap.service');
const { buildIndividualScorecardModel } = require('../services/scoring/scorecard-model.service');

function toPlayerLabel(firstName, lastName) {
  const initial = lastName ? `${String(lastName).charAt(0)}.` : '';
  return `${firstName} ${initial}`.trim();
}

function formatHandicapDisplay(raw) {
  if (raw === null || raw === undefined || raw === '') return '-';
  const num = Number(raw);
  if (!Number.isFinite(num)) return '-';
  const abs = Number.isInteger(num) ? String(Math.abs(num)) : String(Math.abs(num).toFixed(1)).replace(/\\.0$/, '');
  return num < 0 ? `+${abs}` : abs;
}

function ambroseAllowance(memberCount) {
  if (memberCount === 2) return 1 / 4;
  if (memberCount === 3) return 1 / 3;
  return 0;
}

function toWholeShots(raw) {
  return Math.trunc(Number(raw) || 0);
}

function formatAmbroseHandicap(raw, allowance) {
  const num = Number(raw || 0);
  const signPrefix = num < 0 ? '+' : '';
  const abs = Math.abs(num);
  let whole = Math.trunc(abs);
  const fraction = abs - whole;

  let numerator = 0;
  let denominator = 1;

  if (allowance === 1 / 4) {
    denominator = 4;
    numerator = Math.round(fraction * 4);
  } else if (allowance === 1 / 3) {
    denominator = 3;
    numerator = Math.round(fraction * 3);
  }

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

  if (!numerator) return `${signPrefix}${whole}`;
  return `${signPrefix}${whole} ${numerator}/${denominator}`;
}

function formatAmbroseRoundValue(raw, allowance) {
  const num = Number(raw || 0);
  if (!Number.isFinite(num)) return '0';
  const signPrefix = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  let whole = Math.trunc(abs);
  const fraction = abs - whole;

  let denominator = 1;
  if (allowance === 1 / 4) denominator = 4;
  else if (allowance === 1 / 3) denominator = 3;
  if (denominator === 1) return `${signPrefix}${whole}`;

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

  if (!numerator) return `${signPrefix}${whole}`;
  if (!whole) return `${signPrefix}${numerator}/${denominator}`;
  return `${signPrefix}${whole} ${numerator}/${denominator}`;
}

async function getTeamHandicapInfo(db, scorecard) {
  const members = await db('team_members as tm')
    .leftJoin('player_handicaps as ph', function joinPh() {
      this.on('ph.user_id', '=', 'tm.user_id').andOnVal('ph.tour_id', '=', scorecard.tour_id);
    })
    .leftJoin('player_day_handicaps as pdh', function joinPdh() {
      this.on('pdh.user_id', '=', 'tm.user_id').andOnVal('pdh.tour_id', '=', scorecard.tour_id).andOnVal('pdh.round_number', '=', scorecard.round_number);
    })
    .where({ 'tm.team_id': scorecard.team_id })
    .select('tm.user_id', 'ph.playing_handicap', 'pdh.handicap_index as round_handicap_index');

  const count = members.length;
  const allowance = ambroseAllowance(count);
  const courseHandicaps = await Promise.all(members.map((m) => {
    const isOverride = m.round_handicap_index != null;
    const idx = isOverride ? Number(m.round_handicap_index) : Number(m.playing_handicap || 0);
    return getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx, null, null, isOverride);
  }));
  const total = courseHandicaps.reduce((sum, h) => sum + h, 0);
  const raw = total * allowance;
  const wholeShots = toWholeShots(raw);

  return {
    memberCount: count,
    allowance,
    raw,
    wholeShots
  };
}

async function getOrCreateRoundStatus(db, tourId, roundNumber) {
  let row = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
  if (!row) {
    const tour = await db('tours as t')
      .join('tenants as tn', 'tn.id', 't.tenant_id')
      .where({ 't.id': tourId })
      .select('t.*', 'tn.is_test_tenant')
      .first();
    const defaultCourse = await db('courses')
      .where(tour?.is_test_tenant ? {} : { tenant_id: tour?.tenant_id })
      .orderBy('id', 'asc').first();
    if (!defaultCourse) throw new Error('No courses configured');
    await db('golf_rounds').insert({
      tour_id: tourId,
      round_number: roundNumber,
      status: 'draft',
      calc_type: defaultCalcTypeForDay(roundNumber),
      leaderboard_published: 0,
      course_id: Number(defaultCourse.id)
    });
    row = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
  } else if (!row.calc_type) {
    await db('golf_rounds')
      .where({ id: row.id })
      .update({ calc_type: defaultCalcTypeForDay(roundNumber), updated_at: db.fn.now() });
    row = await db('golf_rounds').where({ id: row.id }).first();
  }
  return row;
}

function resolvePlayerCourseId(round, gender) {
  if (gender === 'female' && round.female_course_id) return Number(round.female_course_id);
  return Number(round.course_id);
}

async function getCourseHandicapForRound(db, tourId, roundNumber, handicapIndex, gender = null, _reqCache = null, isOverride = false) {
  if (isOverride) return Math.round(Number(handicapIndex) || 0);
  const reqCacheKey = `${tourId}:${roundNumber}:${gender || 'any'}`;
  let cached = _reqCache?.get(reqCacheKey);
  if (cached === undefined) {
    const round = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
    if (!round) { _reqCache?.set(reqCacheKey, null); return Math.round(Number(handicapIndex) || 0); }
    const courseId = resolvePlayerCourseId(round, gender);
    if (!courseId) { _reqCache?.set(reqCacheKey, null); return Math.round(Number(handicapIndex) || 0); }

    // Module-level cache populated when the round was opened — zero extra DB queries.
    const moduleCached = getCachedCourseData(tourId, roundNumber, courseId);
    if (moduleCached) {
      return computeCourseHandicap(handicapIndex, moduleCached.slope, moduleCached.rating, moduleCached.par, gender);
    }

    // Fallback: round is still draft or cache missed (e.g. first boot) — query DB.
    const course = await db('courses').where({ id: courseId }).first();
    if (!course) { _reqCache?.set(reqCacheKey, null); return Math.round(Number(handicapIndex) || 0); }
    const coursePar = await db('holes').where({ course_id: courseId }).sum({ total: 'par' }).first();
    cached = { course, coursePar };
    _reqCache?.set(reqCacheKey, cached);
  }
  if (!cached) return Math.round(Number(handicapIndex) || 0);
  return computeCourseHandicap(handicapIndex, cached.course.slope_rating, cached.course.course_rating, cached.coursePar?.total || 72, gender);
}

async function getHoleConfig(db, tourId, roundNumber, holeNumber, courseIdOverride = null) {
  if (courseIdOverride) {
    return db('holes')
      .where({ course_id: courseIdOverride, hole_number: holeNumber })
      .select('hole_number', 'par', 'stroke_index_primary', 'stroke_index_secondary')
      .first();
  }
  return db('holes as h')
    .join('golf_rounds as gr', 'gr.course_id', 'h.course_id')
    .where({ 'gr.tour_id': tourId, 'gr.round_number': roundNumber, 'h.hole_number': holeNumber })
    .select('h.hole_number', 'h.par', 'h.stroke_index_primary', 'h.stroke_index_secondary')
    .first();
}

async function getTeeGroupForUser(db, tourId, roundNumber, userId) {
  return db('tee_groups as tg')
    .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
    .where({ 'tg.tour_id': tourId, 'tg.round_number': roundNumber, 'tgp.user_id': userId })
    .select('tg.id', 'tg.starting_hole', 'tg.group_number', 'tg.tee_time', 'tg.tee_location')
    .first();
}

async function getTeeGroupPlayers(db, teeGroupId) {
  return db('tee_group_players as tgp')
    .join('users as u', 'u.id', 'tgp.user_id')
    .where({ 'tgp.tee_group_id': teeGroupId })
    .orderBy('tgp.position', 'asc')
    .select('u.id', 'u.first_name', 'u.last_name');
}

function holeSequenceFrom(startingHole) {
  const start = Math.min(18, Math.max(1, Number(startingHole) || 1));
  const seq = [];
  for (let i = 0; i < 18; i += 1) {
    seq.push(((start - 1 + i) % 18) + 1);
  }
  return seq;
}

function holesUpToCurrent(startingHole, currentHole) {
  const start = Math.min(18, Math.max(1, Number(startingHole) || 1));
  const current = Math.min(18, Math.max(1, Number(currentHole) || 1));
  const holes = [start];
  let hole = start;
  while (hole !== current && holes.length < 18) {
    hole = (hole % 18) + 1;
    holes.push(hole);
  }
  return holes;
}

function isAdmin(req) {
  const role = req.tenantMembership?.role;
  return role === 'admin' || role === 'owner';
}

async function getParByHole(db, tourId, roundNumber) {
  const cached = getCachedParByHole(tourId, roundNumber);
  if (cached) return cached;
  const rows = await db('holes as h')
    .join('golf_rounds as gr', 'gr.course_id', 'h.course_id')
    .where({ 'gr.tour_id': tourId, 'gr.round_number': roundNumber })
    .select('h.hole_number', 'h.par');
  return new Map(rows.map((r) => [Number(r.hole_number), Number(r.par)]));
}

async function getCumulativeByScorecard(db, scorecardIds, holes, parByHole) {
  if (!scorecardIds.length || !holes.length) return new Map();

  const rows = await db('scorecard_holes')
    .whereIn('scorecard_id', scorecardIds)
    .whereIn('hole_number', holes)
    .select('scorecard_id', 'hole_number', 'gross_score', 'stableford_points', 'player_stableford_points');

  const byScorecard = new Map();
  for (const row of rows) {
    const sId = Number(row.scorecard_id);
    if (!byScorecard.has(sId)) {
      byScorecard.set(sId, {
        holesPlayed: 0,
        grossTotal: 0,
        parTotal: 0,
        stablefordTotal: 0,
        playerHolesPlayed: 0,
        playerStablefordTotal: 0
      });
    }
    const target = byScorecard.get(sId);
    const hole = Number(row.hole_number);
    target.holesPlayed += 1;
    target.grossTotal += Number(row.gross_score || 0);
    target.parTotal += Number(parByHole.get(hole) || 0);
    target.stablefordTotal += Number(row.stableford_points || 0);
    // Player-effective stableford: advisory takes priority over marker's authoritative
    const playerStab = row.player_stableford_points != null
      ? Number(row.player_stableford_points)
      : (row.stableford_points != null ? Number(row.stableford_points) : null);
    if (playerStab != null) {
      target.playerHolesPlayed += 1;
      target.playerStablefordTotal += playerStab;
    }
  }

  return byScorecard;
}

async function ensureIndividualScorecard(db, tourId, roundNumber, userId) {
  const existing = await db('scorecards')
    .where({ tour_id: tourId, round_number: roundNumber, type: 'individual', user_id: userId })
    .first();
  if (existing) return Number(existing.id);

  try {
    const ids = await db('scorecards').insert({
      tour_id: tourId,
      round_number: roundNumber,
      type: 'individual',
      user_id: userId,
      status: 'draft'
    });
    return Number(Array.isArray(ids) ? ids[0] : ids);
  } catch (error) {
    const fallback = await db('scorecards')
      .where({ tour_id: tourId, round_number: roundNumber, type: 'individual', user_id: userId })
      .first();
    if (fallback) return Number(fallback.id);
    throw error;
  }
}

async function autoAssignGroupMarkers(db, tourId, roundNumber, slots) {
  if (!slots || slots.length < 2) return;
  const sorted = [...slots].sort((a, b) => Number(a.position) - Number(b.position));
  const n = sorted.length;

  // markerForIdx[i] = index in sorted[] of the player who marks sorted[i]
  // 2-ball: mutual
  // 3-ball: A marks B, B marks C, C marks A  → sorted[i] is marked by sorted[(i+n-1)%n]
  // 4-ball: 1↔2, 3↔4
  let markerForIdx;
  if (n === 2) {
    markerForIdx = [1, 0];
  } else if (n === 3) {
    markerForIdx = [2, 0, 1];
  } else {
    markerForIdx = [1, 0, 3, 2];
  }

  await Promise.all(sorted.map((s) => ensureIndividualScorecard(db, tourId, roundNumber, Number(s.user_id))));

  await db.transaction(async (trx) => {
    for (let i = 0; i < sorted.length; i++) {
      const playerUserId = Number(sorted[i].user_id);
      const markerUserId = Number(sorted[markerForIdx[i]].user_id);
      await trx('scorecards')
        .where({ tour_id: tourId, round_number: roundNumber, type: 'individual', user_id: playerUserId })
        .whereNull('marked_by_user_id')
        .update({ marked_by_user_id: markerUserId, updated_at: trx.fn.now() });
    }
  });
}

async function nextHoleForTeamScorecard(db, scorecardId, startingHole) {
  const rows = await db('scorecard_holes').where({ scorecard_id: scorecardId }).select('hole_number');
  const scored = new Set(rows.map((r) => Number(r.hole_number)));
  const order = holeSequenceFrom(startingHole);
  return order.find((h) => !scored.has(h)) || startingHole;
}

async function getIndividualGroupContext(db, scorecard) {
  const targetGroup = await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, scorecard.user_id);
  if (!targetGroup) return { scorecardIds: [scorecard.id], startingHole: 1 };

  const players = await getTeeGroupPlayers(db, targetGroup.id);
  const scorecardIds = [];
  for (const p of players) {
    const sId = await ensureIndividualScorecard(db, scorecard.tour_id, scorecard.round_number, Number(p.id));
    scorecardIds.push(sId);
  }

  return {
    scorecardIds,
    startingHole: Number(targetGroup.starting_hole || 1)
  };
}

async function nextHoleForIndividualGroup(db, scorecard, startingHole) {
  const ctx = await getIndividualGroupContext(db, scorecard);
  const ids = ctx.scorecardIds;
  if (!ids.length) return startingHole;

  const rows = await db('scorecard_holes')
    .whereIn('scorecard_id', ids)
    .select('scorecard_id', 'hole_number');

  const perHoleCounts = new Map();
  for (const row of rows) {
    const hole = Number(row.hole_number);
    if (!perHoleCounts.has(hole)) perHoleCounts.set(hole, new Set());
    perHoleCounts.get(hole).add(Number(row.scorecard_id));
  }

  const order = holeSequenceFrom(startingHole);
  for (const hole of order) {
    const count = perHoleCounts.get(hole)?.size || 0;
    if (count < ids.length) return hole;
  }
  return startingHole;
}

async function getScoreTotalsByCard(db, scorecardIds) {
  if (!scorecardIds.length) return new Map();
  const rows = await db('scorecard_holes')
    .whereIn('scorecard_id', scorecardIds)
    .select('scorecard_id')
    .sum({ gross_total: 'gross_score' })
    .sum({ stableford_total: 'stableford_points' })
    .count({ holes_scored: '*' })
    .groupBy('scorecard_id');

  const result = new Map();
  for (const row of rows) {
    result.set(Number(row.scorecard_id), {
      grossTotal: Number(row.gross_total || 0),
      stablefordTotal: Number(row.stableford_total || 0),
      holesScored: Number(row.holes_scored || 0)
    });
  }
  return result;
}

async function getMissingHolesByCard(db, scorecardIds) {
  const holesByCard = new Map();
  if (!scorecardIds.length) return holesByCard;
  // A hole only counts as scored when the marker has entered a non-zero gross_score.
  // Rows with gross_score = null (player-only advisory entry) or 0 (cleared) are still missing.
  const rows = await db('scorecard_holes')
    .whereIn('scorecard_id', scorecardIds)
    .where('gross_score', '>', 0)
    .select('scorecard_id', 'hole_number');

  for (const row of rows) {
    const cardId = Number(row.scorecard_id);
    if (!holesByCard.has(cardId)) holesByCard.set(cardId, new Set());
    holesByCard.get(cardId).add(Number(row.hole_number));
  }

  const missingByCard = new Map();
  for (const scorecardId of scorecardIds.map(Number)) {
    const scored = holesByCard.get(scorecardId) || new Set();
    const missing = [];
    for (let hole = 1; hole <= 18; hole += 1) {
      if (!scored.has(hole)) missing.push(hole);
    }
    missingByCard.set(scorecardId, missing);
  }

  return missingByCard;
}

async function buildGroupSnapshot(db, scorecardIds) {
  const ids = (scorecardIds || []).map(Number).filter((id) => Number.isFinite(id));
  if (!ids.length) return '';

  const rows = await db('scorecard_holes')
    .whereIn('scorecard_id', ids)
    .select('scorecard_id', 'hole_number', 'gross_score', 'updated_at')
    .orderBy([{ column: 'scorecard_id', order: 'asc' }, { column: 'hole_number', order: 'asc' }]);

  const normalized = rows.map((row) => {
    const updatedAt = row.updated_at ? new Date(row.updated_at).toISOString() : '';
    return `${Number(row.scorecard_id)}:${Number(row.hole_number)}:${Number(row.gross_score)}:${updatedAt}`;
  });

  return crypto.createHash('sha256').update(normalized.join('|')).digest('hex');
}

async function getHoleSummariesByCard(db, scorecardIds) {
  const ids = (scorecardIds || []).map(Number).filter((id) => Number.isFinite(id));
  const summaries = new Map();
  if (!ids.length) return summaries;

  const rows = await db('scorecard_holes')
    .whereIn('scorecard_id', ids)
    .select('scorecard_id', 'hole_number', 'gross_score', 'stableford_points', 'player_gross_score')
    .orderBy([{ column: 'hole_number', order: 'asc' }, { column: 'scorecard_id', order: 'asc' }]);

  for (const row of rows) {
    const scorecardId = Number(row.scorecard_id);
    if (!summaries.has(scorecardId)) summaries.set(scorecardId, new Map());
    const gs = row.gross_score != null ? Number(row.gross_score) : null;
    const pgs = row.player_gross_score != null ? Number(row.player_gross_score) : null;
    summaries.get(scorecardId).set(Number(row.hole_number), {
      grossScore: gs,
      stablefordPoints:
        row.stableford_points === null || row.stableford_points === undefined
          ? null
          : Number(row.stableford_points),
      playerGrossScore: pgs,
      hasConflict: gs != null && gs > 0 && pgs != null && pgs !== gs,
    });
  }

  return summaries;
}

async function buildConfirmationData(db, scorecard) {
  const holeConfig = await getHoleConfig(db, scorecard.tour_id, scorecard.round_number, 1);
  if (!holeConfig) return { mode: scorecard.type === 'team' ? 'ambrose' : 'individual', entries: [], hasMissing: true };

  let entryCards;
  if (scorecard.type === 'individual') {
    // Show the marker's own card plus the player they are marking (if assigned).
    // Order: player being marked first (matching the live scoring view), then marker.
    const markerId = Number(scorecard.user_id);
    const playerCard = await db('scorecards')
      .where({ tour_id: scorecard.tour_id, round_number: scorecard.round_number, marked_by_user_id: markerId, type: 'individual' })
      .first();

    const pairUserIds = [];
    const pairScorecardIds = [];
    if (playerCard) {
      pairUserIds.push(Number(playerCard.user_id));
      pairScorecardIds.push(Number(playerCard.id));
    }
    pairUserIds.push(markerId);
    pairScorecardIds.push(Number(scorecard.id));

    const [users, tourHandicaps, roundHandicaps] = await Promise.all([
      db('users').whereIn('id', pairUserIds).select('id', 'first_name', 'last_name'),
      db('player_handicaps').where({ tour_id: scorecard.tour_id }).whereIn('user_id', pairUserIds).select('user_id', 'playing_handicap'),
      db('player_day_handicaps').where({ tour_id: scorecard.tour_id, round_number: scorecard.round_number }).whereIn('user_id', pairUserIds).select('user_id', 'handicap_index'),
    ]);
    const userMap = new Map(users.map((u) => [Number(u.id), u]));
    const tourHcpMap = new Map(tourHandicaps.map((h) => [Number(h.user_id), Number(h.playing_handicap || 0)]));
    const roundHcpMap = new Map(roundHandicaps.map((h) => [Number(h.user_id), Number(h.handicap_index)]));

    entryCards = await Promise.all(pairUserIds.map(async (uid, i) => {
      const u = userMap.get(uid);
      const isOverride = roundHcpMap.has(uid);
      const idx = isOverride ? roundHcpMap.get(uid) : (tourHcpMap.get(uid) || 0);
      const playingHandicap = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx, null, null, isOverride);
      return {
        type: 'player',
        scorecardId: pairScorecardIds[i],
        participantId: uid,
        displayName: toPlayerLabel(u?.first_name, u?.last_name),
        fullName: `${u?.first_name || ''} ${u?.last_name || ''}`.trim(),
        playingHandicap,
        handicapDisplay: formatHandicapDisplay(playingHandicap),
      };
    }));
  } else {
    const context = await getAmbroseEntriesForHole(db, scorecard, holeConfig);
    entryCards = context.entries || [];
  }
  const scorecardIds = entryCards
    .map((entry) => Number(entry.scorecardId))
    .filter((id) => Number.isFinite(id));
  const totalsByCard = await getScoreTotalsByCard(db, scorecardIds);
  const missingByCard = await getMissingHolesByCard(db, scorecardIds);
  const holeSummariesByCard = await getHoleSummariesByCard(db, scorecardIds);

  const entries = entryCards.map((entry) => {
    const scorecardId = Number(entry.scorecardId);
    const totals = totalsByCard.get(scorecardId) || { grossTotal: 0, stablefordTotal: 0, holesScored: 0 };
    const missingHoles = missingByCard.get(scorecardId) || [];
    const isTeam = entry.type === 'team';
    const allowance = isTeam ? Number(entry.teamHandicapAllowance || 0) : 0;
    const teamHandicapRaw = isTeam ? Number(entry.teamHandicapRaw ?? entry.teamHandicap ?? 0) : 0;
    const teamHandicapWhole = isTeam ? Number(entry.teamHandicap || 0) : 0;
    const teamHandicapDisplay = isTeam
      ? (entry.teamHandicapDisplay || formatAmbroseRoundValue(teamHandicapRaw, allowance))
      : null;
    const netTotalRaw = isTeam ? totals.grossTotal - teamHandicapRaw : null;
    const netTotalDisplay = isTeam ? formatAmbroseRoundValue(netTotalRaw, allowance) : null;

    return {
      ...entry,
      grossTotal: totals.grossTotal,
      stablefordTotal: totals.stablefordTotal,
      holesScored: totals.holesScored,
      missingHoles,
      teamHandicap: teamHandicapWhole,
      teamHandicapRaw,
      teamHandicapDisplay,
      netTotalRaw,
      netTotalDisplay
    };
  });

  // hasMissing only blocks submission for the primary scorecard being confirmed.
  // The partner's card may have unscored holes without blocking this submission.
  const hasMissing = entries.some((entry) =>
    Number(entry.scorecardId) === Number(scorecard.id) && (entry.missingHoles || []).length > 0
  );
  const holes = [];
  for (let holeNumber = 1; holeNumber <= 18; holeNumber += 1) {
    holes.push({
      holeNumber,
      cells: entries.map((entry) => {
        const scorecardId = Number(entry.scorecardId);
        const holeSummary = holeSummariesByCard.get(scorecardId)?.get(holeNumber) || null;
        const grossScore = holeSummary?.grossScore != null ? Number(holeSummary.grossScore) : null;
        const stablefordPoints =
          holeSummary && holeSummary.stablefordPoints !== null && holeSummary.stablefordPoints !== undefined
            ? Number(holeSummary.stablefordPoints)
            : null;
        return {
          scorecardId,
          grossScore,
          stablefordPoints,
          missing: !holeSummary || !grossScore,
          hasConflict: holeSummary?.hasConflict || false,
          playerGrossScore: holeSummary?.playerGrossScore ?? null,
          displayScore: holeSummary && grossScore ? String(grossScore) : '–'
        };
      })
    });
  }

  const hasConflict = holes.some((h) => h.cells.some((c) => c.hasConflict));

  return {
    mode: scorecard.type === 'team' ? 'ambrose' : 'individual',
    entries,
    holes,
    hasMissing,
    hasConflict,
  };
}

async function canUserEditScorecard(db, requester, scorecard, role = null) {
  if (canEditAllScores(role)) return true;

  if (scorecard.type === 'individual') {
    // Once a marker is assigned, only the card owner and the designated marker may write.
    if (scorecard.marked_by_user_id != null) {
      return Number(requester.id) === Number(scorecard.user_id) ||
             Number(requester.id) === Number(scorecard.marked_by_user_id);
    }
    // No marker assigned yet — fall back to same-tee-group check.
    const requesterGroup = await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, requester.id);
    const targetGroup = await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, scorecard.user_id);
    return Boolean(requesterGroup && targetGroup && requesterGroup.id === targetGroup.id);
  }

  const requesterGroup = await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, requester.id);
  return Boolean(requesterGroup);
}

async function getGroupEntriesForHole(db, scorecard, holeConfig, preloadedTargetGroup = null) {
  const targetGroup = preloadedTargetGroup !== null
    ? preloadedTargetGroup
    : await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, scorecard.user_id);
  if (!targetGroup) {
    const player = await db('users')
      .where({ id: scorecard.user_id })
      .select('id', 'first_name', 'last_name')
      .first();
    if (!player) return { entries: [], startingHole: 1 };

    const roundHcp = await db('player_day_handicaps')
      .where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id, round_number: scorecard.round_number })
      .first();
    const tourHcp = await db('player_handicaps')
      .where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id })
      .first();
    const isHcpOverride = !!roundHcp;
    const handicapIndex = isHcpOverride ? Number(roundHcp.handicap_index) : (tourHcp ? Number(tourHcp.playing_handicap || 0) : 0);
    const playingHandicap = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, handicapIndex, null, null, isHcpOverride);

    const saved = await db('scorecard_holes')
      .where({ scorecard_id: scorecard.id, hole_number: holeConfig.hole_number })
      .first();
    const grossScore = saved ? Number(saved.gross_score) : null;
    const pgs = saved?.player_gross_score != null ? Number(saved.player_gross_score) : null;
    const ppStab = saved?.player_stableford_points != null ? Number(saved.player_stableford_points) : null;
    const stableford =
      saved && saved.stableford_points !== null
        ? Number(saved.stableford_points)
        : grossScore === null
          ? null
          : stablefordPoints({
              grossScore,
              par: holeConfig.par,
              strokeIndexPrimary: holeConfig.stroke_index_primary,
              strokeIndexSecondary: holeConfig.stroke_index_secondary,
              playingHandicap
            }).points;
    const playerStableford = ppStab !== null ? ppStab : stableford;

    return {
      entries: [
        {
          type: 'player',
          scorecardId: Number(scorecard.id),
          participantId: Number(player.id),
          displayName: toPlayerLabel(player.first_name, player.last_name),
          fullName: `${player.first_name || ''} ${player.last_name || ''}`.trim(),
          playingHandicap,
          handicapDisplay: formatHandicapDisplay(playingHandicap),
          grossScore,
          playerGrossScore: pgs,
          holeVersion: saved ? Number(saved.version || 1) : 0,
          stableford,
          playerStablefordPoints: ppStab,
          stablefordTotal: stableford === null ? 0 : stableford,
          stablefordRelative: stableford === null ? 0 : stableford - 2,
          playerStablefordTotal: playerStableford === null ? 0 : playerStableford,
          playerStablefordRelative: playerStableford === null ? 0 : playerStableford - 2,
          hasScoreConflict: grossScore != null && grossScore > 0 && pgs != null && pgs !== grossScore,
        }
      ],
      startingHole: 1,
      individualContext: null
    };
  }

  const players = await getTeeGroupPlayers(db, targetGroup.id);
  const playerIds = players.map((p) => Number(p.id));
  // Bulk fetch all scorecards for this group in one query; create any missing in parallel.
  const existingCards = await db('scorecards')
    .where({ tour_id: scorecard.tour_id, round_number: scorecard.round_number, type: 'individual' })
    .whereIn('user_id', playerIds)
    .select('id', 'user_id');
  const scorecardByUser = new Map(existingCards.map((r) => [Number(r.user_id), Number(r.id)]));
  const missingIds = playerIds.filter((uid) => !scorecardByUser.has(uid));
  if (missingIds.length) {
    await Promise.all(missingIds.map(async (uid) => {
      const sId = await ensureIndividualScorecard(db, scorecard.tour_id, scorecard.round_number, uid);
      scorecardByUser.set(uid, sId);
    }));
  }

  const round = await db('golf_rounds').where({ tour_id: scorecard.tour_id, round_number: scorecard.round_number }).first();
  const hasFemaleCoourse = Boolean(round?.female_course_id);

  const [tourHandicaps, roundHandicaps, playerGenderRows] = await Promise.all([
    db('player_handicaps').where({ tour_id: scorecard.tour_id }).whereIn('user_id', playerIds).select('user_id', 'playing_handicap'),
    db('player_day_handicaps').where({ tour_id: scorecard.tour_id, round_number: scorecard.round_number }).whereIn('user_id', playerIds).select('user_id', 'handicap_index'),
    hasFemaleCoourse ? db('users').whereIn('id', playerIds).select('id', 'gender') : Promise.resolve([]),
  ]);
  const tourHcpByUser = new Map(tourHandicaps.map((h) => [Number(h.user_id), Number(h.playing_handicap || 0)]));
  const roundHcpByUser = new Map(roundHandicaps.map((h) => [Number(h.user_id), Number(h.handicap_index)]));
  const genderByUser = new Map(playerGenderRows.map((r) => [Number(r.id), r.gender]));
  const handicapByUser = new Map(
    await Promise.all(playerIds.map(async (uid) => {
      const isOverride = roundHcpByUser.has(uid);
      const idx = isOverride ? roundHcpByUser.get(uid) : (tourHcpByUser.get(uid) || 0);
      return [uid, await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx, genderByUser.get(uid) || null, null, isOverride)];
    }))
  );

  const holeConfigByUser = hasFemaleCoourse
    ? new Map(await Promise.all(playerIds.map(async (uid) => {
        const courseId = resolvePlayerCourseId(round, genderByUser.get(uid) || null);
        const cfg = await getHoleConfig(db, scorecard.tour_id, scorecard.round_number, holeConfig.hole_number, courseId);
        return [uid, cfg || holeConfig];
      })))
    : null;

  const holeScores = await db('scorecard_holes as sh')
    .join('scorecards as s', 's.id', 'sh.scorecard_id')
    .where({
      's.tour_id': scorecard.tour_id,
      's.round_number': scorecard.round_number,
      's.type': 'individual',
      'sh.hole_number': holeConfig.hole_number
    })
    .whereIn('s.user_id', playerIds)
    .select('s.user_id', 'sh.gross_score', 'sh.stableford_points', 'sh.player_stableford_points', 'sh.version', 'sh.player_gross_score');
  const holeScoreByUser = new Map(holeScores.map((row) => [row.user_id, row]));
  const scorecardIds = [...scorecardByUser.values()].filter((v) => Number.isFinite(Number(v))).map(Number);
  const parByHole = await getParByHole(db, scorecard.tour_id, scorecard.round_number);
  const windowHoles = holesUpToCurrent(targetGroup.starting_hole, holeConfig.hole_number);
  const cumulativeByScorecard = await getCumulativeByScorecard(db, scorecardIds, windowHoles, parByHole);

  const entries = players
    .map((p) => {
      const userId = Number(p.id);
      const playingHandicap = handicapByUser.get(userId) || 0;
      const saved = holeScoreByUser.get(userId);
      const grossScore = saved ? Number(saved.gross_score) : null;
      const pgs = saved?.player_gross_score != null ? Number(saved.player_gross_score) : null;
      const ppStab = saved?.player_stableford_points != null ? Number(saved.player_stableford_points) : null;
      const scorecardId = scorecardByUser.get(userId);
      const playerHoleConfig = (holeConfigByUser && holeConfigByUser.get(userId)) || holeConfig;
      const stableford =
        saved && saved.stableford_points !== null
          ? Number(saved.stableford_points)
          : grossScore === null
            ? null
            : stablefordPoints({
                grossScore,
                par: playerHoleConfig.par,
                strokeIndexPrimary: playerHoleConfig.stroke_index_primary,
                strokeIndexSecondary: playerHoleConfig.stroke_index_secondary,
                playingHandicap
              }).points;
      const cumulative = cumulativeByScorecard.get(Number(scorecardId)) || {
        holesPlayed: 0,
        stablefordTotal: 0,
        playerHolesPlayed: 0,
        playerStablefordTotal: 0
      };
      const stablefordTotal = Number(cumulative.stablefordTotal || 0);
      const stablefordRelative = stablefordTotal - (Number(cumulative.holesPlayed || 0) * 2);
      const playerStablefordTotal = Number(cumulative.playerStablefordTotal || 0);
      const playerStablefordRelative = playerStablefordTotal - (Number(cumulative.playerHolesPlayed || 0) * 2);

      return {
        type: 'player',
        scorecardId,
        participantId: userId,
        displayName: toPlayerLabel(p.first_name, p.last_name),
        fullName: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        playingHandicap,
        handicapDisplay: formatHandicapDisplay(playingHandicap),
        grossScore,
        playerGrossScore: pgs,
        holeVersion: saved ? Number(saved.version || 1) : 0,
        stableford,
        playerStablefordPoints: ppStab,
        stablefordTotal,
        stablefordRelative,
        playerStablefordTotal,
        playerStablefordRelative,
        hasScoreConflict: grossScore != null && grossScore > 0 && pgs != null && pgs !== grossScore,
      };
    });

  return {
    entries,
    startingHole: Number(targetGroup.starting_hole || 1),
    individualContext: {
      groupNumber: targetGroup.group_number || null,
      teeTime: targetGroup.tee_time || null,
      teeLocation: targetGroup.tee_location || null
    }
  };
}

async function getAmbroseEntriesForHole(db, scorecard, holeConfig) {
  const team = await db('teams as t')
    .leftJoin('ambrose_groups as ag', 'ag.id', 't.ambrose_group_id')
    .where({ 't.id': scorecard.team_id })
    .select(
      't.id',
      't.name',
      't.ambrose_group_id',
      'ag.group_number',
      'ag.tee_time',
      'ag.tee_location',
      'ag.starting_hole as group_starting_hole'
    )
    .first();
  if (!team) return { entries: [], startingHole: 1 };

  let startingHole = Number(team.group_starting_hole || 1);
  const scopedTeams = team.ambrose_group_id
    ? await db('teams')
        .where({
          tour_id: scorecard.tour_id,
          round_number: scorecard.round_number,
          competition_type: 'ambrose',
          ambrose_group_id: team.ambrose_group_id
        })
        .orderBy('id', 'asc')
        .select('id', 'name')
    : [{ id: team.id, name: team.name }];

  const teamIds = scopedTeams.map((t) => t.id);
  const scorecardRows = await db('scorecards')
    .where({
      tour_id: scorecard.tour_id,
      round_number: scorecard.round_number,
      type: 'team'
    })
    .whereIn('team_id', teamIds)
    .select('id', 'team_id');
  const scorecardByTeamId = new Map(scorecardRows.map((r) => [Number(r.team_id), Number(r.id)]));
  const scorecardIds = scorecardRows.map((r) => Number(r.id));

  const membersRaw = await db('team_members as tm')
    .join('users as u', 'u.id', 'tm.user_id')
    .leftJoin('player_handicaps as ph', function joinPh() {
      this.on('ph.user_id', '=', 'u.id').andOnVal('ph.tour_id', '=', scorecard.tour_id);
    })
    .leftJoin('player_day_handicaps as pdh', function joinPdh() {
      this.on('pdh.user_id', '=', 'u.id').andOnVal('pdh.tour_id', '=', scorecard.tour_id).andOnVal('pdh.round_number', '=', scorecard.round_number);
    })
    .whereIn('tm.team_id', teamIds)
    .orderBy('u.first_name', 'asc')
    .select('tm.team_id', 'u.id', 'u.first_name', 'u.last_name', 'ph.playing_handicap', 'pdh.handicap_index as round_handicap_index');

  const membersRows = await Promise.all(membersRaw.map(async (m) => {
    const isOverride = m.round_handicap_index != null;
    const idx = isOverride ? Number(m.round_handicap_index) : Number(m.playing_handicap || 0);
    const courseHcp = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx, null, null, isOverride);
    return { ...m, playing_handicap: courseHcp };
  }));

  const membersByTeam = new Map();
  for (const row of membersRows) {
    const key = Number(row.team_id);
    if (!membersByTeam.has(key)) membersByTeam.set(key, []);
    membersByTeam.get(key).push(row);
  }

  const holeScores = scorecardIds.length
    ? await db('scorecard_holes')
        .whereIn('scorecard_id', scorecardIds)
        .andWhere({ hole_number: holeConfig.hole_number })
        .select('scorecard_id', 'gross_score', 'stableford_points', 'version')
    : [];
  const holeScoreByScorecard = new Map(holeScores.map((r) => [Number(r.scorecard_id), r]));

  const driveRows = scorecardIds.length
    ? await db('ambrose_drives')
        .whereIn('scorecard_id', scorecardIds)
        .andWhere({ hole_number: holeConfig.hole_number })
        .select('scorecard_id', 'drive_taken_user_id')
    : [];
  const driveByScorecard = new Map(driveRows.map((r) => [Number(r.scorecard_id), Number(r.drive_taken_user_id)]));

  const allDrives = scorecardIds.length
    ? await db('ambrose_drives').whereIn('scorecard_id', scorecardIds).select('scorecard_id', 'drive_taken_user_id')
    : [];
  const driveCountsByScorecard = new Map();
  for (const row of allDrives) {
    const sId = Number(row.scorecard_id);
    const uId = Number(row.drive_taken_user_id);
    if (!driveCountsByScorecard.has(sId)) driveCountsByScorecard.set(sId, new Map());
    const counts = driveCountsByScorecard.get(sId);
    counts.set(uId, (counts.get(uId) || 0) + 1);
  }

  const parByHole = await getParByHole(db, scorecard.tour_id, scorecard.round_number);
  const windowHoles = holesUpToCurrent(startingHole, holeConfig.hole_number);
  const cumulativeByScorecard = await getCumulativeByScorecard(db, scorecardIds, windowHoles, parByHole);

  const entries = scopedTeams.map((t) => {
    const teamId = Number(t.id);
    const sId = scorecardByTeamId.get(teamId) || null;
    const savedHole = sId ? holeScoreByScorecard.get(sId) : null;
    const driveCounts = sId && driveCountsByScorecard.has(sId) ? driveCountsByScorecard.get(sId) : new Map();
    const memberRows = membersByTeam.get(teamId) || [];
    const members = memberRows.map((m) => ({
      userId: m.id,
      displayName: toPlayerLabel(m.first_name, m.last_name),
      fullName: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
      playingHandicap: Number(m.playing_handicap || 0),
      handicapDisplay: formatHandicapDisplay(m.playing_handicap),
      driveCount: driveCounts.get(Number(m.id)) || 0
    }));

    const allowance = ambroseAllowance(members.length);
    const rawTeamHandicap = memberRows.reduce((sum, m) => sum + Number(m.playing_handicap || 0), 0) * allowance;
    const wholeTeamHandicap = toWholeShots(rawTeamHandicap);
    const cumulative = sId
      ? (cumulativeByScorecard.get(Number(sId)) || { grossTotal: 0, parTotal: 0, holesPlayed: 0 })
      : { grossTotal: 0, parTotal: 0, holesPlayed: 0 };
    const grossToPar =
      Number(cumulative.holesPlayed || 0) > 0
        ? Number(cumulative.grossTotal || 0) - Number(cumulative.parTotal || 0)
        : 0;

    return {
      type: 'team',
      scorecardId: sId,
      participantId: teamId,
      displayName: t.name,
      teamHandicap: wholeTeamHandicap,
      teamHandicapRaw: rawTeamHandicap,
      teamHandicapAllowance: allowance,
      teamHandicapDisplay: formatAmbroseHandicap(rawTeamHandicap, allowance),
      grossScore: savedHole ? Number(savedHole.gross_score) : null,
      holeVersion: savedHole ? Number(savedHole.version || 1) : 0,
      stableford: savedHole && savedHole.stableford_points !== null ? Number(savedHole.stableford_points) : null,
      grossToPar,
      selectedDriveUserId: sId ? driveByScorecard.get(sId) || null : null,
      members
    };
  });

  const pairedTeams = entries
    .filter((e) => Number(e.participantId) !== Number(team.id))
    .map((e) => ({ id: e.participantId, name: e.displayName, scorecard_id: e.scorecardId }));

  return {
    entries,
    startingHole,
    ambroseContext: {
      groupNumber: team.group_number || null,
      teeTime: team.tee_time || null,
      teeLocation: team.tee_location || null,
      pairedTeams
    }
  };
}

function scoringRouter(db) {
  const router = express.Router();

  router.get('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const message = req.query.message ? String(req.query.message) : '';
    const errorMessage = req.query.error ? String(req.query.error).replace(/\+/g, ' ') : '';

    const ownScorecardIds = await db('scorecards as s')
      .join('tours as t', 't.id', 's.tour_id')
      .where({ 's.user_id': user.id, 's.type': 'individual', 't.tenant_id': req.tenant.id })
      .pluck('s.id');

    const teamScorecardRows = await db('scorecards as s')
      .join('tours as t', 't.id', 's.tour_id')
      .join('teams as tm_t', 'tm_t.id', 's.team_id')
      .join('team_members as tm', function joinTm() {
        this.on('tm.team_id', '=', 'tm_t.id').andOnVal('tm.user_id', '=', user.id);
      })
      .where({ 's.type': 'team', 't.tenant_id': req.tenant.id })
      .distinct('s.id');

    const scorecardIds = new Set([
      ...ownScorecardIds.map(Number),
      ...teamScorecardRows.map((r) => Number(r.id))
    ]);

    const scorecards = await db('scorecards as s')
      .leftJoin('users as u', 'u.id', 's.user_id')
      .leftJoin('teams as t', 't.id', 's.team_id')
      .leftJoin('ambrose_groups as ag', 'ag.id', 't.ambrose_group_id')
      .select(
        's.id',
        's.tour_id',
        's.round_number',
        's.type',
        's.status',
        's.user_id',
        's.team_id',
        's.marked_by_user_id',
        'u.first_name',
        'u.last_name',
        'u.gender as user_gender',
        't.ambrose_group_id',
        't.name as team_name',
        'ag.group_number as ambrose_group_number',
        'ag.tee_time as ambrose_tee_time',
        'ag.tee_location as ambrose_tee_location',
        'ag.starting_hole as ambrose_starting_hole',
        db.raw(`
          (
            SELECT gr.status
            FROM golf_rounds gr
            WHERE gr.tour_id = s.tour_id AND gr.round_number = s.round_number
            LIMIT 1
          ) as round_status
        `),
        db.raw(`
          (
            SELECT gr.two_ball_enabled
            FROM golf_rounds gr
            WHERE gr.tour_id = s.tour_id AND gr.round_number = s.round_number
            LIMIT 1
          ) as two_ball_enabled
        `),
        db.raw(`
          (
            SELECT gr.two_ball_type
            FROM golf_rounds gr
            WHERE gr.tour_id = s.tour_id AND gr.round_number = s.round_number
            LIMIT 1
          ) as two_ball_type
        `),
        db.raw(`
          (
            SELECT tg.group_number
            FROM tee_groups tg
            JOIN tee_group_players tgp ON tgp.tee_group_id = tg.id
            WHERE tg.tour_id = s.tour_id
              AND tg.round_number = s.round_number
              AND tgp.user_id = s.user_id
            LIMIT 1
          ) as individual_group_number
        `),
        db.raw(`
          (
            SELECT tg.tee_time
            FROM tee_groups tg
            JOIN tee_group_players tgp ON tgp.tee_group_id = tg.id
            WHERE tg.tour_id = s.tour_id
              AND tg.round_number = s.round_number
              AND tgp.user_id = s.user_id
            LIMIT 1
          ) as individual_tee_time
        `),
        db.raw(`
          (
            SELECT tg.starting_hole
            FROM tee_groups tg
            JOIN tee_group_players tgp ON tgp.tee_group_id = tg.id
            WHERE tg.tour_id = s.tour_id
              AND tg.round_number = s.round_number
              AND tgp.user_id = s.user_id
            LIMIT 1
          ) as individual_starting_hole
        `)
      )
      .whereIn('s.id', [...scorecardIds])
      .orderBy([{ column: 's.round_number', order: 'asc' }, { column: 's.id', order: 'asc' }]);

    const hcpCache = new Map();
    const enrichedScorecards = await Promise.all(
      scorecards.map(async (scorecard) => {
        let otherPlayers = [];
        let ambroseTeamHandicapDisplay = null;
        let ambroseOtherTeams = [];
        let ownHandicapDisplay = null;

        if (scorecard.type === 'individual' && scorecard.user_id) {
          const roundHcp = await db('player_day_handicaps').where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id, round_number: scorecard.round_number }).first();
          const tourHcp = await db('player_handicaps').where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id }).first();
          const isHcpOverride = !!roundHcp;
          const idx = isHcpOverride ? Number(roundHcp.handicap_index) : (tourHcp ? Number(tourHcp.playing_handicap || 0) : 0);
          const courseHcp = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx, scorecard.user_gender || null, hcpCache, isHcpOverride);
          ownHandicapDisplay = formatHandicapDisplay(courseHcp);
        }

        if (scorecard.type === 'individual' && scorecard.user_id) {
          const rawOtherPlayers = await db('tee_groups as tg')
            .join('tee_group_players as me', function joinMe() {
              this.on('me.tee_group_id', '=', 'tg.id').andOnVal('me.user_id', '=', scorecard.user_id);
            })
            .join('tee_group_players as peers', 'peers.tee_group_id', 'tg.id')
            .join('users as u', 'u.id', 'peers.user_id')
            .leftJoin('player_handicaps as ph', function joinPh() {
              this.on('ph.user_id', '=', 'u.id').andOnVal('ph.tour_id', '=', scorecard.tour_id);
            })
            .leftJoin('player_day_handicaps as pdh', function joinPdh() {
              this.on('pdh.user_id', '=', 'u.id').andOnVal('pdh.tour_id', '=', scorecard.tour_id).andOnVal('pdh.round_number', '=', scorecard.round_number);
            })
            .leftJoin('scorecards as psc', function joinPsc() {
              this.on('psc.user_id', '=', 'u.id')
                .andOnVal('psc.tour_id', '=', scorecard.tour_id)
                .andOnVal('psc.round_number', '=', scorecard.round_number)
                .andOnVal('psc.type', '=', 'individual');
            })
            .where({ 'tg.tour_id': scorecard.tour_id, 'tg.round_number': scorecard.round_number })
            .whereNot('peers.user_id', scorecard.user_id)
            .select('u.first_name', 'u.last_name', 'u.gender', 'ph.playing_handicap', 'pdh.handicap_index as round_handicap_index', 'psc.id as peer_scorecard_id', 'psc.status as peer_status')
            .orderBy('peers.position', 'asc');
          otherPlayers = await Promise.all(rawOtherPlayers.map(async (p) => {
            const isOverride = p.round_handicap_index != null;
            const idx = isOverride ? Number(p.round_handicap_index) : Number(p.playing_handicap || 0);
            const courseHcp = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx, p.gender || null, hcpCache, isOverride);
            return { ...p, playing_handicap: courseHcp };
          }));
        }

        if (
          scorecard.type === 'team' &&
          scorecard.team_id &&
          scorecard.ambrose_group_id
        ) {
          const rawOtherTeamPlayers = await db('teams as t2')
            .join('team_members as tm2', 'tm2.team_id', 't2.id')
            .join('users as u', 'u.id', 'tm2.user_id')
            .leftJoin('player_handicaps as ph', function joinPh() {
              this.on('ph.user_id', '=', 'u.id').andOnVal('ph.tour_id', '=', scorecard.tour_id);
            })
            .leftJoin('player_day_handicaps as pdh', function joinPdh() {
              this.on('pdh.user_id', '=', 'u.id').andOnVal('pdh.tour_id', '=', scorecard.tour_id).andOnVal('pdh.round_number', '=', scorecard.round_number);
            })
            .where({
              't2.tour_id': scorecard.tour_id,
              't2.round_number': scorecard.round_number,
              't2.competition_type': 'ambrose',
              't2.ambrose_group_id': scorecard.ambrose_group_id
            })
            .whereNot('t2.id', scorecard.team_id)
            .select('u.first_name', 'u.last_name', 'ph.playing_handicap', 'pdh.handicap_index as round_handicap_index')
            .orderBy('u.first_name', 'asc');
          otherPlayers = await Promise.all(rawOtherTeamPlayers.map(async (p) => {
            const isOverride = p.round_handicap_index != null;
            const idx = isOverride ? Number(p.round_handicap_index) : Number(p.playing_handicap || 0);
            const courseHcp = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx, null, hcpCache, isOverride);
            return { ...p, playing_handicap: courseHcp };
          }));

          const groupTeams = await db('teams')
            .where({
              tour_id: scorecard.tour_id,
              round_number: scorecard.round_number,
              competition_type: 'ambrose',
              ambrose_group_id: scorecard.ambrose_group_id
            })
            .select('id', 'name')
            .orderBy('id', 'asc');

          const teamIds = groupTeams.map((gt) => Number(gt.id));
          const memberRows = teamIds.length
            ? await db('team_members as tm')
                .leftJoin('player_handicaps as ph', function joinPh() {
                  this.on('ph.user_id', '=', 'tm.user_id').andOnVal('ph.tour_id', '=', scorecard.tour_id);
                })
                .whereIn('tm.team_id', teamIds)
                .select('tm.team_id', 'ph.playing_handicap')
            : [];

          const membersByTeam = new Map();
          for (const row of memberRows) {
            const key = Number(row.team_id);
            if (!membersByTeam.has(key)) membersByTeam.set(key, []);
            membersByTeam.get(key).push(Number(row.playing_handicap || 0));
          }

          const toTeamHcpDisplay = (teamId) => {
            const memberHandicaps = membersByTeam.get(Number(teamId)) || [];
            const allowance = ambroseAllowance(memberHandicaps.length);
            const raw = memberHandicaps.reduce((sum, h) => sum + h, 0) * allowance;
            return formatAmbroseHandicap(raw, allowance);
          };

          ambroseTeamHandicapDisplay = toTeamHcpDisplay(scorecard.team_id);
          ambroseOtherTeams = groupTeams
            .filter((gt) => Number(gt.id) !== Number(scorecard.team_id))
            .map((gt) => ({
              name: gt.name,
              handicapDisplay: toTeamHcpDisplay(gt.id)
            }));
        }

        let twoBallInfo = null;
        if (
          scorecard.type === 'individual' &&
          scorecard.user_id &&
          scorecard.two_ball_enabled &&
          scorecard.round_status === 'open' &&
          scorecard.status !== 'submitted'
        ) {
          const groupMembersRaw = await db('tee_groups as tg')
            .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
            .join('users as u', 'u.id', 'tgp.user_id')
            .leftJoin('player_handicaps as ph2', function joinPh2() {
              this.on('ph2.user_id', '=', 'u.id').andOnVal('ph2.tour_id', '=', scorecard.tour_id);
            })
            .leftJoin('player_day_handicaps as pdh2', function joinPdh2() {
              this.on('pdh2.user_id', '=', 'u.id')
                .andOnVal('pdh2.tour_id', '=', scorecard.tour_id)
                .andOnVal('pdh2.round_number', '=', scorecard.round_number);
            })
            .where({ 'tg.tour_id': scorecard.tour_id, 'tg.round_number': scorecard.round_number })
            .whereExists(
              db('tee_group_players as me2')
                .whereRaw('me2.tee_group_id = tg.id')
                .where('me2.user_id', scorecard.user_id)
            )
            .select(
              'u.id as userId', 'u.first_name', 'u.last_name', 'u.gender',
              'tgp.id as tgpId', 'tgp.position',
              'ph2.playing_handicap',
              'pdh2.handicap_index as round_hcp_index'
            )
            .orderByRaw('tgp.position ASC, tgp.id ASC');

          // Use stable ordinal rank (sort by position then row id) so corrupt or
          // gapped positions from the DB do not misassign ball pairings.
          const groupMembers = [...groupMembersRaw].sort(
            (a, b) => Number(a.position) - Number(b.position) || Number(a.tgpId) - Number(b.tgpId)
          );

          if (groupMembers.length >= 2) {
            const myOrdinal = groupMembers.findIndex((m) => Number(m.userId) === Number(scorecard.user_id));
            const myPosition = myOrdinal >= 0 ? myOrdinal + 1 : 1;
            const groupSize = groupMembers.length;
            const twoBallType = scorecard.two_ball_type || 'best_ball';

            const membersWithHcp = await Promise.all(groupMembers.map(async (m, idx) => {
              const isOverride = m.round_hcp_index != null;
              const hIdx = isOverride ? Number(m.round_hcp_index) : Number(m.playing_handicap || 0);
              const courseHcp = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, hIdx, m.gender || null, hcpCache, isOverride);
              return {
                userId: Number(m.userId),
                fullName: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
                position: idx + 1,
                isMe: Number(m.userId) === scorecard.user_id,
                courseHcp,
              };
            }));

            const groupUserIds = membersWithHcp.map((m) => m.userId);
            const [{ cnt: scoredCount }] = await db('scorecards as sc')
              .join('scorecard_holes as sh', 'sh.scorecard_id', 'sc.id')
              .whereIn('sc.user_id', groupUserIds)
              .where({ 'sc.tour_id': scorecard.tour_id, 'sc.round_number': scorecard.round_number })
              .where('sh.gross_score', '>', 0)
              .count('sh.id as cnt');
            const scoringStarted = Number(scoredCount) > 0;

            if (groupSize === 4) {
              const myBallPositions = myPosition <= 2 ? [1, 2] : [3, 4];
              const myPartner = membersWithHcp.find((m) => !m.isMe && myBallPositions.includes(m.position));
              const selectablePartners = scoringStarted ? [] : membersWithHcp.filter((m) => !m.isMe && !myBallPositions.includes(m.position));
              twoBallInfo = { groupSize: 4, twoBallType, myPartner: myPartner || null, selectablePartners, scoringStarted };
            } else if (groupSize === 3) {
              const sorted = [...membersWithHcp].sort((a, b) => a.courseHcp - b.courseHcp);
              const shared = { ...sorted[0], isShared: true };
              const others = sorted.slice(1);
              twoBallInfo = {
                groupSize: 3,
                twoBallType,
                scoringStarted,
                teams: [
                  { label: 'Ball A', players: [others[0], shared] },
                  { label: 'Ball B', players: [others[1], shared] },
                ],
              };
            }
          }
        }

        // Marker info for individual scorecards in open rounds
        let markerInfo = null;
        if (scorecard.type === 'individual' && scorecard.round_status === 'open' && scorecard.status !== 'submitted') {
          let [playerCardRow, slots] = await Promise.all([
            db('scorecards as s')
              .join('users as u', 'u.id', 's.user_id')
              .where({ 's.tour_id': scorecard.tour_id, 's.round_number': scorecard.round_number, 's.marked_by_user_id': user.id, 's.type': 'individual' })
              .select('s.user_id as player_user_id', 'u.first_name', 'u.last_name')
              .first(),
            db('tee_groups as tg')
              .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
              .join('users as u', 'u.id', 'tgp.user_id')
              .where({ 'tg.tour_id': scorecard.tour_id, 'tg.round_number': scorecard.round_number })
              .whereExists(
                db('tee_group_players as me')
                  .whereRaw('me.tee_group_id = tg.id')
                  .where('me.user_id', user.id)
              )
              .select('tgp.user_id', 'tgp.position', 'u.first_name', 'u.last_name')
              .orderBy('tgp.position'),
          ]);

          const mySlot = slots.find((s) => Number(s.user_id) === user.id);
          if (mySlot) {
            // Auto-assign markers based on tee group position if no assignment exists yet.
            // Idempotent: only updates rows where marked_by_user_id IS NULL.
            if (!playerCardRow && scorecard.marked_by_user_id == null) {
              await autoAssignGroupMarkers(db, scorecard.tour_id, scorecard.round_number, slots);
              const [freshCard, freshSc] = await Promise.all([
                db('scorecards as s')
                  .join('users as u', 'u.id', 's.user_id')
                  .where({ 's.tour_id': scorecard.tour_id, 's.round_number': scorecard.round_number, 's.marked_by_user_id': user.id, 's.type': 'individual' })
                  .select('s.user_id as player_user_id', 'u.first_name', 'u.last_name')
                  .first(),
                db('scorecards').where({ id: scorecard.id }).select('marked_by_user_id').first(),
              ]);
              playerCardRow = freshCard;
              scorecard.marked_by_user_id = freshSc?.marked_by_user_id ?? null;
            }

            if (playerCardRow) {
              const markerRow = scorecard.marked_by_user_id
                ? await db('users').where({ id: scorecard.marked_by_user_id }).select('first_name', 'last_name').first()
                : null;
              markerInfo = {
                assigned: true,
                playerBeingMarked: `${playerCardRow.first_name || ''} ${playerCardRow.last_name || ''}`.trim(),
                markedBy: markerRow ? `${markerRow.first_name || ''} ${markerRow.last_name || ''}`.trim() : null,
                changeOptions: [],
              };
            } else {
              markerInfo = { assigned: false };
            }

          }
        }

        const peerById = new Map(
          otherPlayers
            .filter((p) => p.peer_scorecard_id)
            .map((p) => [Number(p.peer_scorecard_id), p])
        );

        let groupSummary = null;
        if (scorecard.status === 'submitted') {
          if (scorecard.type === 'individual') {
            // Build full tee-group summary — all group members, not just the marking pair.
            const allGroupScorecardIds = [Number(scorecard.id)];
            for (const p of otherPlayers) {
              if (p.peer_scorecard_id) allGroupScorecardIds.push(Number(p.peer_scorecard_id));
            }
            const groupTotals = await getScoreTotalsByCard(db, allGroupScorecardIds);
            const ownTotals = groupTotals.get(Number(scorecard.id)) || { stablefordTotal: 0 };
            groupSummary = [
              {
                isTeam: false,
                fullName: `${scorecard.first_name || ''} ${scorecard.last_name || ''}`.trim(),
                scorecardId: Number(scorecard.id),
                scoreLabel: `${Number(ownTotals.stablefordTotal || 0)} pts`,
                handicapDisplay: ownHandicapDisplay,
                isCurrentUser: true,
                submitted: true,
              },
              ...otherPlayers.map((p) => {
                const scId = p.peer_scorecard_id ? Number(p.peer_scorecard_id) : null;
                const submitted = p.peer_status === 'submitted';
                const totals = scId ? (groupTotals.get(scId) || { stablefordTotal: 0 }) : null;
                return {
                  isTeam: false,
                  fullName: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
                  scorecardId: submitted ? scId : null,
                  scoreLabel: submitted && totals ? `${Number(totals.stablefordTotal || 0)} pts` : 'Pending',
                  handicapDisplay: formatHandicapDisplay(p.playing_handicap),
                  isCurrentUser: false,
                  submitted,
                };
              }),
            ];
          } else {
            // Team (ambrose) — derive summary from confirmation entries as before.
            const confirmation = await buildConfirmationData(db, scorecard);
            groupSummary = confirmation.entries.map((entry) => {
              const entryScId = Number(entry.scorecardId);
              const isCurrentUser = entryScId === Number(scorecard.id);
              const peer = peerById.get(entryScId);
              const submitted = isCurrentUser || peer?.peer_status === 'submitted';
              if (entry.type === 'team') {
                return {
                  isTeam: true,
                  fullName: entry.displayName,
                  scorecardId: null,
                  scoreLabel: `Net ${entry.netTotalDisplay || Number(entry.netTotalRaw || 0)}`,
                  detail: `Gross ${Number(entry.grossTotal || 0)} - Hcp ${entry.teamHandicapDisplay || Number(entry.teamHandicapRaw || 0)}`,
                  handicapDisplay: null,
                  isCurrentUser,
                  submitted,
                };
              }
              return {
                isTeam: false,
                fullName: entry.fullName,
                scorecardId: entry.scorecardId,
                scoreLabel: `${Number(entry.stablefordTotal || 0)} pts`,
                detail: null,
                handicapDisplay: entry.handicapDisplay,
                isCurrentUser,
                submitted,
              };
            });
          }
        }

        return {
          ...scorecard,
          ambroseTeamHandicapDisplay,
          ambroseOtherTeams,
          ownHandicapDisplay,
          twoBallInfo,
          markerInfo,
          groupSummary,
          otherPlayers: otherPlayers.map((p) => ({
            fullName: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
            handicapDisplay: formatHandicapDisplay(p.playing_handicap),
          }))
        };
      })
    );

    const orderedScorecards = [...enrichedScorecards].sort((a, b) => {
      const aActionableOpen = String(a.round_status || '') === 'open' && String(a.status || '') !== 'submitted';
      const bActionableOpen = String(b.round_status || '') === 'open' && String(b.status || '') !== 'submitted';
      if (aActionableOpen !== bActionableOpen) return aActionableOpen ? -1 : 1;

      const aSubmitted = String(a.status || '') === 'submitted';
      const bSubmitted = String(b.status || '') === 'submitted';
      if (aSubmitted !== bSubmitted) return aSubmitted ? 1 : -1;

      const roundDiff = Number(a.round_number || 0) - Number(b.round_number || 0);
      if (roundDiff !== 0) return roundDiff;

      return Number(a.id || 0) - Number(b.id || 0);
    });

    return res.render('scorer/index', {
      title: 'Scoring',
      user,
      scorecards: orderedScorecards,
      canEditAll: false,
      message,
      errorMessage,
      dayLabel
    });
  });

  // -------------------------------------------------------------------------
  // Group scorecard view — shows all scorecards for the player's tee group
  // Access: leaderboard-gated per round; admins/scorers bypass
  // -------------------------------------------------------------------------
  router.get('/:scorecardId/group', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = parseInt(req.params.scorecardId, 10);
      const userId = Number(req.session.user.id);
      const isPrivileged = canEditAllScores(req.tenantMembership?.role);

      const scorecard = await db('scorecards as s')
        .join('tours as t', 't.id', 's.tour_id')
        .where('s.id', scorecardId)
        .where('t.tenant_id', req.tenant.id)
        .where('s.type', 'individual')
        .where(function () {
          if (!isPrivileged) this.where('s.user_id', userId);
        })
        .select('s.id', 's.tour_id', 's.round_number', 's.user_id', 't.label as tour_label')
        .first();

      if (!scorecard) return res.status(404).send('Scorecard not found');

      const tourId = Number(scorecard.tour_id);
      const roundNumber = Number(scorecard.round_number);
      const scorecardUserId = Number(scorecard.user_id);

      const tour = await db('tours').where({ id: tourId }).first();

      const teeGroup = await db('tee_group_players as tgp')
        .join('tee_groups as tg', 'tg.id', 'tgp.tee_group_id')
        .where({ 'tg.tour_id': tourId, 'tg.round_number': roundNumber, 'tgp.user_id': scorecardUserId })
        .select('tg.id as group_id', 'tg.group_number')
        .first();

      if (!teeGroup) return res.status(404).send('No tee group found for this round');

      const groupPlayers = await db('tee_group_players as tgp')
        .where('tgp.tee_group_id', teeGroup.group_id)
        .orderBy('tgp.position')
        .select('tgp.user_id');

      const roundRow = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
      const isPublished = Boolean(roundRow?.leaderboard_published);

      const models = (await Promise.all(
        groupPlayers.map((p) => buildIndividualScorecardModel(db, tour, roundNumber, Number(p.user_id)))
      )).filter(Boolean);

      const leaderboardUrl = res.locals.tenantPath(`/leaderboards/tour/${tourId}`);

      res.render('scorer/group-scorecard', {
        title: `Group ${teeGroup.group_number} — ${dayLabel(roundNumber)}`,
        pageSubtitle: scorecard.tour_label,
        roundNumber,
        groupNumber: teeGroup.group_number,
        isPublished,
        leaderboardUrl,
        models,
        backUrl: res.locals.tenantPath('/scoring'),
        user: req.session.user,
      });
    } catch (err) { next(err); }
  });

  router.post('/select-partner', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.body.scorecardId);
      const partnerId = Number(req.body.partnerId);
      const userId = req.session.user.id;

      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard || Number(scorecard.user_id) !== userId) {
        return res.redirect(res.locals.tenantPath('/scoring?error=Not+found'));
      }

      const round = await db('golf_rounds')
        .where({ tour_id: scorecard.tour_id, round_number: scorecard.round_number })
        .first();
      if (!round?.two_ball_enabled || round.status !== 'open') {
        return res.redirect(res.locals.tenantPath('/scoring?error=Partner+selection+not+available'));
      }

      // Load all slots in this player's tee group
      const slots = await db('tee_groups as tg')
        .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
        .where({ 'tg.tour_id': scorecard.tour_id, 'tg.round_number': scorecard.round_number })
        .whereExists(
          db('tee_group_players as me')
            .whereRaw('me.tee_group_id = tg.id')
            .where('me.user_id', userId)
        )
        .select('tgp.id', 'tgp.user_id', 'tgp.position')
        .orderBy('tgp.position');

      const mySlot = slots.find((s) => Number(s.user_id) === userId);
      const partnerSlot = slots.find((s) => Number(s.user_id) === partnerId);

      if (!mySlot || !partnerSlot) {
        return res.redirect(res.locals.tenantPath('/scoring?error=Players+not+in+same+group'));
      }

      // Lock once any player in this group has a non-zero hole score.
      // A score of 0 is treated as cleared, so it does not lock the group.
      const groupUserIds = slots.map((s) => s.user_id);
      const scoredCount = await db('scorecards as sc')
        .join('scorecard_holes as sh', 'sh.scorecard_id', 'sc.id')
        .whereIn('sc.user_id', groupUserIds)
        .where({ 'sc.tour_id': scorecard.tour_id, 'sc.round_number': scorecard.round_number })
        .where('sh.gross_score', '>', 0)
        .count('sh.id as cnt')
        .first();
      if (Number(scoredCount?.cnt || 0) > 0) {
        return res.redirect(res.locals.tenantPath('/scoring?error=Partner+cannot+be+changed+once+scoring+has+started'));
      }

      // Use stable ordinal rank (sort by position then row id) to determine ball
      // pairings — robust against corrupt or gapped position values in the DB.
      const sortedSlots = [...slots].sort(
        (a, b) => Number(a.position) - Number(b.position) || Number(a.id) - Number(b.id)
      );
      const myRank = sortedSlots.findIndex((s) => Number(s.user_id) === userId) + 1;
      const partnerRank = sortedSlots.findIndex((s) => Number(s.user_id) === partnerId) + 1;
      const myBallRanks = myRank <= 2 ? [1, 2] : [3, 4];

      // Already partners — nothing to do
      if (myBallRanks.includes(partnerRank)) {
        return res.redirect(res.locals.tenantPath('/scoring'));
      }

      // Ball A: me + selected partner (positions 1, 2)
      // Ball B: the remaining two players (positions 3, 4)
      const ballBSlots = sortedSlots.filter((s) => Number(s.user_id) !== userId && Number(s.user_id) !== partnerId);
      const bSlot = ballBSlots[0];
      const dSlot = ballBSlots[1] || null;

      if (!bSlot) {
        return res.redirect(res.locals.tenantPath('/scoring?error=Unexpected+group+layout'));
      }

      // Ensure scorecards exist for all players in the group.
      const ensurePromises = [
        ensureIndividualScorecard(db, scorecard.tour_id, scorecard.round_number, userId),
        ensureIndividualScorecard(db, scorecard.tour_id, scorecard.round_number, Number(bSlot.user_id)),
        ensureIndividualScorecard(db, scorecard.tour_id, scorecard.round_number, partnerId),
      ];
      if (dSlot) ensurePromises.push(ensureIndividualScorecard(db, scorecard.tour_id, scorecard.round_number, Number(dSlot.user_id)));
      const [myScorecardId, bScorecardId, partnerScorecardId, dScorecardId] = await Promise.all(ensurePromises);

      const allGroupUserIds = slots.map((s) => s.user_id);

      await db.transaction(async (trx) => {
        // Assign canonical positions 1-4 to all players so the group is always
        // left in a clean state regardless of any prior position corruption.
        await trx('tee_group_players').where({ id: mySlot.id }).update({ position: 1 });
        await trx('tee_group_players').where({ id: partnerSlot.id }).update({ position: 2 });
        await trx('tee_group_players').where({ id: bSlot.id }).update({ position: 3 });
        if (dSlot) await trx('tee_group_players').where({ id: dSlot.id }).update({ position: 4 });

        // Clear all marker assignments in this group — all pairings change.
        await trx('scorecards')
          .where({ tour_id: scorecard.tour_id, round_number: scorecard.round_number, type: 'individual' })
          .whereIn('user_id', allGroupUserIds)
          .update({ marked_by_user_id: null, updated_at: trx.fn.now() });

        // Mutual assignment for Ball A pair: me ↔ partner.
        await trx('scorecards').where({ id: myScorecardId }).update({ marked_by_user_id: partnerId, updated_at: trx.fn.now() });
        await trx('scorecards').where({ id: partnerScorecardId }).update({ marked_by_user_id: userId, updated_at: trx.fn.now() });

        // Mutual assignment for Ball B pair: B ↔ D.
        if (bScorecardId && dScorecardId && dSlot) {
          const bUserId = Number(bSlot.user_id);
          const dUserId = Number(dSlot.user_id);
          await trx('scorecards').where({ id: bScorecardId }).update({ marked_by_user_id: dUserId, updated_at: trx.fn.now() });
          await trx('scorecards').where({ id: dScorecardId }).update({ marked_by_user_id: bUserId, updated_at: trx.fn.now() });
        }
      });

      return res.redirect(res.locals.tenantPath('/scoring?message=Partner+updated'));
    } catch (err) { return next(err); }
  });

  router.post('/select-player', requireAuth, async (req, res, next) => {
    try {
      const markerUserId = req.session.user.id;
      const playerUserId = Number(req.body.playerUserId);
      const roundNumber = Number(req.body.roundNumber);
      const tp = res.locals.tenantPath;

      if (!Number.isFinite(playerUserId) || playerUserId === markerUserId) {
        return res.redirect(tp('/scoring?error=Invalid+player+selection'));
      }
      if (!Number.isFinite(roundNumber) || roundNumber <= 0) {
        return res.redirect(tp('/scoring?error=Invalid+round'));
      }

      // Find the active tour for this tenant
      const tour = await db('tours').where({ tenant_id: req.tenant.id, status: 'active' }).first();
      if (!tour) return res.redirect(tp('/scoring?error=No+active+tour'));

      // Find the specific open round by round_number
      const round = await db('golf_rounds').where({ tour_id: tour.id, round_number: roundNumber, status: 'open' }).first();
      if (!round) return res.redirect(tp('/scoring?error=No+open+round'));

      // Both users must be in the same tee group
      const slots = await db('tee_groups as tg')
        .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
        .where({ 'tg.tour_id': tour.id, 'tg.round_number': round.round_number })
        .whereExists(
          db('tee_group_players as me')
            .whereRaw('me.tee_group_id = tg.id')
            .where('me.user_id', markerUserId)
        )
        .select('tgp.user_id', 'tgp.position')
        .orderBy('tgp.position');

      const mySlot = slots.find((s) => Number(s.user_id) === markerUserId);
      const playerSlot = slots.find((s) => Number(s.user_id) === playerUserId);
      if (!mySlot || !playerSlot) {
        return res.redirect(tp('/scoring?error=Players+not+in+same+group'));
      }

      const groupSize = slots.length;
      const isFourBall = groupSize >= 4;

      if (isFourBall) {
        // In a 4-ball, partners are determined by position: 1+2 or 3+4.
        const myPos = Number(mySlot.position);
        const playerPos = Number(playerSlot.position);
        const validPair = (myPos <= 2 && playerPos <= 2) || (myPos >= 3 && playerPos >= 3);
        if (!validPair) {
          return res.redirect(tp('/scoring?error=Invalid+pairing+for+this+group'));
        }
      }
      // 3-ball: any player may select any other player in the group — no positional restriction.

      // Lock once any player in this group has a non-zero hole score.
      // A score of 0 is treated as cleared, so it does not lock the group.
      const groupUserIds = slots.map((s) => s.user_id);
      const [{ cnt }] = await db('scorecards as sc')
        .join('scorecard_holes as sh', 'sh.scorecard_id', 'sc.id')
        .whereIn('sc.user_id', groupUserIds)
        .where({ 'sc.tour_id': tour.id, 'sc.round_number': round.round_number })
        .where('sh.gross_score', '>', 0)
        .count('sh.id as cnt');
      if (Number(cnt) > 0) {
        return res.redirect(tp('/scoring?error=Player+cannot+be+changed+once+scoring+has+started'));
      }

      // Ensure both scorecards exist
      const [markerScorecardId, playerScorecardId] = await Promise.all([
        ensureIndividualScorecard(db, tour.id, round.round_number, markerUserId),
        ensureIndividualScorecard(db, tour.id, round.round_number, playerUserId),
      ]);

      // Find A's current claim before the transaction (who A is currently marking, if anyone).
      const oldPlayerCard = await db('scorecards')
        .where({ tour_id: tour.id, round_number: round.round_number, marked_by_user_id: markerUserId, type: 'individual' })
        .first();

      // 4-ball: mutual assignment (A marks B AND B marks A — they're partners).
      // 3-ball: one-way assignment only (A marks B; B independently selects C; C selects A).
      // Cascade: clear any stale claims caused by this selection before writing new ones.
      await db.transaction(async (trx) => {
        // Clear A's previous claim if switching to a different player.
        if (oldPlayerCard && Number(oldPlayerCard.user_id) !== playerUserId) {
          await trx('scorecards')
            .where({ id: oldPlayerCard.id })
            .update({ marked_by_user_id: null, updated_at: trx.fn.now() });
        }

        if (isFourBall) {
          // C was in a mutual pair with D (C marked D, D was marked by C).
          // Since C is moving into a new pair with A, D loses their marker.
          await trx('scorecards')
            .where({ tour_id: tour.id, round_number: round.round_number, marked_by_user_id: playerUserId, type: 'individual' })
            .whereNot({ user_id: markerUserId })
            .update({ marked_by_user_id: null, updated_at: trx.fn.now() });
        }

        // Set C.marked_by = A
        await trx('scorecards').where({ id: playerScorecardId }).update({ marked_by_user_id: markerUserId, updated_at: trx.fn.now() });

        // 4-ball mutual: Set A.marked_by = C
        if (isFourBall) {
          await trx('scorecards').where({ id: markerScorecardId }).update({ marked_by_user_id: playerUserId, updated_at: trx.fn.now() });
        }
      });

      return res.redirect(tp('/scoring?message=Player+selected'));
    } catch (err) { return next(err); }
  });

  router.get('/session/:roundNumber', requireAuth, async (req, res, next) => {
    try {
      const roundNumber = Number(req.params.roundNumber);
      const userId = req.session.user.id;
      const tp = res.locals.tenantPath;

      if (!Number.isInteger(roundNumber) || roundNumber <= 0) return res.redirect(tp('/scoring'));

      const tour = await db('tours').where({ tenant_id: req.tenant.id, status: 'active' }).first();
      if (!tour) return res.redirect(tp('/scoring'));

      const [ownScorecard, playerCard] = await Promise.all([
        db('scorecards').where({ tour_id: tour.id, round_number: roundNumber, user_id: userId, type: 'individual' }).first(),
        db('scorecards').where({ tour_id: tour.id, round_number: roundNumber, marked_by_user_id: userId, type: 'individual' }).first(),
      ]);
      if (!ownScorecard) return res.redirect(tp('/scoring'));

      // Ready when the marker has selected their player (they appear as marker on the player's card).
      if (!playerCard) {
        return res.redirect(tp('/scoring?error=Select+your+player+before+opening+scoring'));
      }

      const roundStatus = await getOrCreateRoundStatus(db, tour.id, roundNumber);
      const payload = {
        mode: 'individual',
        scorecardId: ownScorecard.id,
        tourId: tour.id,
        roundNumber,
        sessionMode: true,
      };

      return res.render('scorer/live', {
        title: 'Live Scoring',
        user: req.session.user,
        payload,
        dayStatus: roundStatus,
        dayLabel,
      });
    } catch (err) { return next(err); }
  });

  router.get('/live/:scorecardId', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).send('Scorecard not found');

      const [permitted, roundStatus] = await Promise.all([
        canUserEditScorecard(db, req.session.user, scorecard, req.tenantMembership?.role),
        getOrCreateRoundStatus(db, scorecard.tour_id, scorecard.round_number),
      ]);
      if (!permitted) return res.status(403).send('Not allowed');

      // Minimal payload — client calls /api/live/:id/init for all static context.
      const payload = {
        mode: scorecard.type === 'team' ? 'ambrose' : 'individual',
        scorecardId: scorecard.id,
        tourId: scorecard.tour_id,
        roundNumber: scorecard.round_number,
        sessionMode: scorecard.type === 'individual',
      };

      return res.render('scorer/live', {
        title: 'Live Scorecard',
        user: req.session.user,
        payload,
        dayStatus: roundStatus,
        dayLabel
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/card/:scorecardId', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).send('Scorecard not found');

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard, req.tenantMembership?.role);
      if (!permitted) return res.status(403).send('Not allowed');

      const tour = await db('tours').where({ id: scorecard.tour_id, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const model = await buildIndividualScorecardModel(db, tour, scorecard.round_number, scorecard.user_id);
      if (!model) return res.status(404).send('Scorecard not found');

      const tp = res.locals.tenantPath;
      const back = req.query.back;
      const backUrl = back === 'scoring' ? tp('/scoring') : tp(`/scoring/confirm/${scorecard.id}/final`);
      const backLabel = back === 'scoring' ? 'Back to Scoring' : 'Back to Submission';
      return res.render('leaderboard/scorecard-view', {
        title: model.title,
        user: req.session.user,
        activeTour: tour,
        models: [model],
        backUrl,
        backLabel,
        pageSubtitle: 'Scorecard'
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/confirm/:scorecardId', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).send('Scorecard not found');

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard, req.tenantMembership?.role);
      if (!permitted) return res.status(403).send('Not allowed');

      const confirmation = await buildConfirmationData(db, scorecard);
      const returnHole = parseInt(req.query.returnHole, 10) || null;

      return res.render('scorer/confirm', {
        title: 'Review Scores',
        user: req.session.user,
        scorecard,
        confirmation,
        returnHole,
        canSubmit: scorecard.status !== 'submitted' && !confirmation.hasMissing && !confirmation.hasConflict,
        submitError: null,
        dayLabel
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/confirm/:scorecardId/final', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const errorCode = String(req.query.error || '').trim();
      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).send('Scorecard not found');

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard, req.tenantMembership?.role);
      if (!permitted) return res.status(403).send('Not allowed');

      const confirmation = await buildConfirmationData(db, scorecard);
      if (scorecard.status !== 'submitted' && confirmation.hasMissing) {
        return res.redirect(res.locals.tenantPath(`/scoring/confirm/${scorecardId}`));
      }

      const canSubmit = scorecard.status !== 'submitted' && !confirmation.hasMissing && !confirmation.hasConflict;
      const submitSnapshot = await buildGroupSnapshot(db, [scorecardId]);

      return res.render('scorer/confirm-final', {
        title: 'Submit Scorecard',
        user: req.session.user,
        scorecard,
        confirmation,
        canSubmit,
        submitError: null,
        submitSnapshot,
        staleScores: errorCode === 'stale_scores',
        dayLabel
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/confirm/:scorecardId/submit', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).send('Scorecard not found');

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard, req.tenantMembership?.role);
      if (!permitted) return res.status(403).send('Not allowed');
      if (scorecard.status === 'submitted') {
        return res.status(409).json({
          error: 'already_finalized',
          redirect: res.locals.tenantPath('/scoring?message=Scores%20already%20finalised')
        });
      }

      // The card owner or their designated marker (or admin) may submit.
      // A third-party player (neither owner nor marker) may not.
      const requesterId = Number(req.session.user.id);
      const markerUserId = scorecard.marked_by_user_id != null ? Number(scorecard.marked_by_user_id) : null;
      const cardOwnerId = Number(scorecard.user_id);
      if (!canEditAllScores(req.tenantMembership?.role) && markerUserId != null && requesterId !== markerUserId && requesterId !== cardOwnerId) {
        return res.status(403).send('Not allowed to submit this scorecard');
      }

      const confirmation = await buildConfirmationData(db, scorecard);
      if (confirmation.hasMissing) {
        return res.status(409).json({
          error: 'missing_scores',
          message: 'All holes must be scored before submission.'
        });
      }
      if (confirmation.hasConflict) {
        return res.status(409).json({
          error: 'score_conflict',
          message: 'Score disagreement must be resolved before submission.'
        });
      }

      // Submit only this single scorecard — not the whole group.
      const submittedSnapshot = String(req.body?.submitSnapshot || '').trim();
      const currentSnapshot = await buildGroupSnapshot(db, [scorecardId]);
      if (!submittedSnapshot || submittedSnapshot !== currentSnapshot) {
        return res.status(409).json({
          error: 'stale_scores',
          message: 'Scores changed since confirmation. Please review before submitting.',
          redirect: res.locals.tenantPath(`/scoring/confirm/${scorecardId}?error=stale_scores`)
        });
      }

      const updated = await db('scorecards')
        .where({ id: scorecardId })
        .whereNot({ status: 'submitted' })
        .update({ status: 'submitted', updated_at: db.fn.now() });

      if (!updated) {
        return res.status(409).json({
          error: 'already_finalized',
          redirect: res.locals.tenantPath('/scoring?message=Scores%20already%20finalised')
        });
      }

      await markLeaderboardDirty(db, scorecard.tour_id);

      return res.json({
        ok: true,
        redirect: res.locals.tenantPath('/scoring?message=Scores%20submitted%20successfully')
      });
    } catch (error) {
      return next(error);
    }
  });

  // Init endpoint — returns static context (players, handicaps, all hole configs) once per page load.
  // Subsequent hole navigations use the lean ?sids= branch below instead of re-fetching this data.
  router.get('/api/live/:scorecardId/init', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);

      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).json({ error: 'Scorecard not found' });
      if (scorecard.status === 'submitted' && !isAdmin(req)) {
        return res.status(409).json({ error: 'Scorecard has been submitted and is locked' });
      }

      // Warm the module cache before the handicap computation below.
      if (!isRoundCacheWarm(scorecard.tour_id, scorecard.round_number)) {
        await warmRoundCourseCache(db, scorecard.tour_id, scorecard.round_number);
      }

      // Fetch target group + round in parallel; target group is reused for the
      // permission check so we avoid calling getTeeGroupForUser twice.
      const [targetGroup, round] = await Promise.all([
        scorecard.type === 'individual'
          ? getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, scorecard.user_id)
          : null,
        db('golf_rounds').where({ tour_id: scorecard.tour_id, round_number: scorecard.round_number }).first(),
      ]);

      // Permission: admin always passes. Others must share a tee group with the
      // scorecard owner. When requester IS the owner, reuse targetGroup (saves a query).
      if (!canEditAllScores(req.tenantMembership?.role)) {
        let permitted = false;
        if (scorecard.type === 'individual') {
          const requesterGroup = Number(req.session.user.id) === Number(scorecard.user_id)
            ? targetGroup
            : await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, req.session.user.id);
          permitted = Boolean(requesterGroup && targetGroup && requesterGroup.id === targetGroup.id);
        } else {
          const requesterGroup = await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, req.session.user.id);
          permitted = Boolean(requesterGroup);
        }
        if (!permitted) return res.status(403).json({ error: 'Not allowed' });
      }

      const hasFemale = Boolean(round?.female_course_id);
      const startingHole = targetGroup ? Number(targetGroup.starting_hole || 1) : 1;

      // ── Players, scorecards, handicaps ───────────────────────────────────
      let players = [];
      let scorecardIds = [Number(scorecard.id)];
      let individualContext = null;

      if (scorecard.type === 'individual') {
        if (targetGroup) {
          individualContext = {
            groupNumber: targetGroup.group_number || null,
            teeTime: targetGroup.tee_time || null,
            teeLocation: targetGroup.tee_location || null
          };

          const groupPlayers = await getTeeGroupPlayers(db, targetGroup.id);
          const playerIds = groupPlayers.map((p) => Number(p.id));

          // Bulk-fetch existing scorecards; create missing in parallel.
          const existingCards = await db('scorecards')
            .where({ tour_id: scorecard.tour_id, round_number: scorecard.round_number, type: 'individual' })
            .whereIn('user_id', playerIds)
            .select('id', 'user_id', 'marked_by_user_id');
          const scorecardByUser = new Map(existingCards.map((r) => [Number(r.user_id), Number(r.id)]));
          const markerByUser = new Map(existingCards.map((r) => [Number(r.user_id), r.marked_by_user_id != null ? Number(r.marked_by_user_id) : null]));
          const missingIds = playerIds.filter((uid) => !scorecardByUser.has(uid));
          if (missingIds.length) {
            await Promise.all(missingIds.map(async (uid) => {
              const sId = await ensureIndividualScorecard(db, scorecard.tour_id, scorecard.round_number, uid);
              scorecardByUser.set(uid, sId);
            }));
          }
          scorecardIds = playerIds.map((uid) => scorecardByUser.get(uid)).filter(Boolean);

          // Tour handicaps, round overrides, and genders all in parallel.
          const [tourHandicaps, roundHandicaps, genderRows] = await Promise.all([
            db('player_handicaps').where({ tour_id: scorecard.tour_id }).whereIn('user_id', playerIds).select('user_id', 'playing_handicap'),
            db('player_day_handicaps').where({ tour_id: scorecard.tour_id, round_number: scorecard.round_number }).whereIn('user_id', playerIds).select('user_id', 'handicap_index'),
            hasFemale ? db('users').whereIn('id', playerIds).select('id', 'gender') : Promise.resolve([]),
          ]);
          const tourHcpByUser = new Map(tourHandicaps.map((h) => [Number(h.user_id), Number(h.playing_handicap || 0)]));
          const roundHcpByUser = new Map(roundHandicaps.map((h) => [Number(h.user_id), Number(h.handicap_index)]));
          const genderByUser = new Map(genderRows.map((r) => [Number(r.id), r.gender]));

          // getCourseHandicapForRound hits the module cache — 0 DB queries when warm.
          const handicapByUser = new Map(
            await Promise.all(playerIds.map(async (uid) => {
              const isOverride = roundHcpByUser.has(uid);
              const hcpIndex = isOverride ? roundHcpByUser.get(uid) : (tourHcpByUser.get(uid) || 0);
              const gender = genderByUser.get(uid) || null;
              return [uid, await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, hcpIndex, gender, null, isOverride)];
            }))
          );

          players = groupPlayers.map((p) => {
            const uid = Number(p.id);
            const playingHandicap = handicapByUser.get(uid) || 0;
            return {
              scorecardId: scorecardByUser.get(uid),
              participantId: uid,
              displayName: toPlayerLabel(p.first_name, p.last_name),
              fullName: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
              playingHandicap,
              handicapDisplay: formatHandicapDisplay(playingHandicap),
              courseId: round ? resolvePlayerCourseId(round, genderByUser.get(uid) || null) : null,
              markedByUserId: markerByUser.get(uid) ?? null,
            };
          });
        } else {
          // No tee group — single-player fallback.
          const [player, roundHcp, tourHcp] = await Promise.all([
            db('users').where({ id: scorecard.user_id }).select('id', 'first_name', 'last_name', 'gender').first(),
            db('player_day_handicaps').where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id, round_number: scorecard.round_number }).first(),
            db('player_handicaps').where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id }).first(),
          ]);
          if (player) {
            const isHcpOverride = !!roundHcp;
            const hcpIndex = isHcpOverride ? Number(roundHcp.handicap_index) : (tourHcp ? Number(tourHcp.playing_handicap || 0) : 0);
            const playingHandicap = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, hcpIndex, player.gender || null, null, isHcpOverride);
            players = [{
              scorecardId: Number(scorecard.id),
              participantId: Number(player.id),
              displayName: toPlayerLabel(player.first_name, player.last_name),
              fullName: `${player.first_name || ''} ${player.last_name || ''}`.trim(),
              playingHandicap,
              handicapDisplay: formatHandicapDisplay(playingHandicap),
              courseId: round ? resolvePlayerCourseId(round, player.gender || null) : null
            }];
          }
        }
      }

      // ── Hole configs: all holes in one query per course ──────────────────
      const primaryCourseId = round ? Number(round.course_id) : null;
      const femaleCourseId = round && round.female_course_id ? Number(round.female_course_id) : null;
      const courseIdsToFetch = [primaryCourseId, femaleCourseId].filter(Boolean);
      const allHoleRows = courseIdsToFetch.length
        ? await db('holes')
            .whereIn('course_id', courseIdsToFetch)
            .select('course_id', 'hole_number', 'par', 'stroke_index_primary', 'stroke_index_secondary')
        : [];

      const holesByCourse = {};
      for (const row of allHoleRows) {
        const cId = String(row.course_id);
        if (!holesByCourse[cId]) holesByCourse[cId] = {};
        holesByCourse[cId][Number(row.hole_number)] = {
          par: Number(row.par),
          strokeIndexPrimary: Number(row.stroke_index_primary),
          strokeIndexSecondary: Number(row.stroke_index_secondary)
        };
      }
      const holes = primaryCourseId ? (holesByCourse[String(primaryCourseId)] || {}) : {};
      const femaleHoles = femaleCourseId ? (holesByCourse[String(femaleCourseId)] || null) : null;

      // ── Current hole: first hole in play order not yet fully scored ───────
      const holeOrder = holeSequenceFrom(startingHole);
      let currentHole = startingHole;
      if (scorecardIds.length) {
        const scoredRows = await db('scorecard_holes')
          .whereIn('scorecard_id', scorecardIds)
          .select('hole_number');
        const perHoleCounts = new Map();
        for (const row of scoredRows) {
          const h = Number(row.hole_number);
          perHoleCounts.set(h, (perHoleCounts.get(h) || 0) + 1);
        }
        for (const h of holeOrder) {
          if ((perHoleCounts.get(h) || 0) < scorecardIds.length) {
            currentHole = h;
            break;
          }
        }
      }

      // Session mode: filter to the marker's own card + the card they're marking.
      // All other group members become passivePlayers (read-only display).
      let passivePlayers = null;
      let allScorecardIds = scorecardIds; // includes passive; used by JS for ?sids= queries
      if (req.query.session === '1' && scorecard.type === 'individual') {
        const playerCard = await db('scorecards as s')
          .join('users as u', 'u.id', 's.user_id')
          .where({ 's.tour_id': scorecard.tour_id, 's.round_number': scorecard.round_number, 's.marked_by_user_id': scorecard.user_id, 's.type': 'individual' })
          .select('s.id', 's.user_id', 'u.first_name', 'u.last_name')
          .first();

        if (playerCard) {
          const ownEntry = players.find((p) => Number(p.scorecardId) === Number(scorecard.id));
          const playerEntry = players.find((p) => Number(p.scorecardId) === Number(playerCard.id));
          passivePlayers = players.filter((p) => Number(p.scorecardId) !== Number(scorecard.id) && Number(p.scorecardId) !== Number(playerCard.id));
          allScorecardIds = scorecardIds; // keep full group for passive score fetching
          // Player being marked goes first — they're the primary focus of the session.
          players = [playerEntry, ownEntry].filter(Boolean);
          scorecardIds = players.map((p) => Number(p.scorecardId)).filter(Boolean); // active only for hole advancement

          // Recalculate currentHole using only the 2 active cards — the pair
          // may be ahead of the other pair in the group.
          if (scorecardIds.length) {
            const activeScoredRows = await db('scorecard_holes')
              .whereIn('scorecard_id', scorecardIds)
              .select('hole_number');
            const activeCounts = new Map();
            for (const row of activeScoredRows) {
              const h = Number(row.hole_number);
              activeCounts.set(h, (activeCounts.get(h) || 0) + 1);
            }
            for (const h of holeOrder) {
              if ((activeCounts.get(h) || 0) < scorecardIds.length) {
                currentHole = h;
                break;
              }
            }
          }
        }
      }

      return res.json({
        mode: scorecard.type === 'team' ? 'ambrose' : 'individual',
        scorecardId: Number(scorecard.id),
        currentUserId: Number(req.session.user.id),
        canEditAll: Boolean(canEditAllScores(req.tenantMembership?.role)),
        startingHole,
        currentHole,
        holeOrder,
        requesterDisplay: toPlayerLabel(
          req.session.user.firstName || req.session.user.first_name || '',
          req.session.user.lastName || req.session.user.last_name || ''
        ),
        individualContext,
        players,
        passivePlayers,
        holes,
        femaleHoles,
        primaryCourseId,
        femaleCourseId,
        scorecardIds,
        allScorecardIds,
        twoBallEnabled: Boolean(round?.two_ball_enabled),
        twoBallType: round?.two_ball_type || null,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/api/live/:scorecardId/hole/:holeNumber', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const holeNumber = Number(req.params.holeNumber);
      if (holeNumber < 1 || holeNumber > 18) return res.status(400).json({ error: 'Invalid hole' });

      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).json({ error: 'Scorecard not found' });
      if (scorecard.status === 'submitted' && !isAdmin(req)) {
        return res.status(409).json({ error: 'Scorecard has been submitted and is locked' });
      }

      // ── Lean path: client has already loaded ctx via /init ────────────────
      // ?sids=42,43,44 — scorecard IDs for the group (from init response)
      // ?start=N       — starting hole for cumulative window (from init response)
      const rawSids = req.query.sids;
      if (rawSids) {
        const sids = rawSids.split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (!sids.length) return res.status(400).json({ error: 'Invalid sids' });

        // Permission: same check as the full path. Admins skip the DB queries.
        if (!canEditAllScores(req.tenantMembership?.role)) {
          if (scorecard.type === 'individual') {
            const requesterGroup = await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, req.session.user.id);
            const targetGroup = await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, scorecard.user_id);
            if (!requesterGroup || !targetGroup || requesterGroup.id !== targetGroup.id) {
              return res.status(403).json({ error: 'Not allowed' });
            }
          } else {
            const requesterGroup = await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, req.session.user.id);
            if (!requesterGroup) return res.status(403).json({ error: 'Not allowed' });
          }
        }

        // Scores for this hole and cumulative totals — the only dynamic data.
        const startingHole = Number(req.query.start || 1);
        const windowHoles = holesUpToCurrent(startingHole, holeNumber);
        const parByHole = await getParByHole(db, scorecard.tour_id, scorecard.round_number);

        const [holeScores, cumulativeByScorecard] = await Promise.all([
          db('scorecard_holes')
            .whereIn('scorecard_id', sids)
            .where({ hole_number: holeNumber })
            .select('scorecard_id', 'gross_score', 'stableford_points', 'player_stableford_points', 'version', 'owner_user_id', 'player_gross_score'),
          getCumulativeByScorecard(db, sids, windowHoles, parByHole),
        ]);

        const holeScoreByCard = new Map(holeScores.map((r) => [Number(r.scorecard_id), r]));
        const scores = sids.map((sid) => {
          const saved = holeScoreByCard.get(sid);
          const cumulative = cumulativeByScorecard.get(sid) || { holesPlayed: 0, stablefordTotal: 0, playerHolesPlayed: 0, playerStablefordTotal: 0 };
          const gs = saved?.gross_score != null ? Number(saved.gross_score) : null;
          const pgs = saved?.player_gross_score != null ? Number(saved.player_gross_score) : null;
          const psp = saved?.player_stableford_points != null ? Number(saved.player_stableford_points) : null;
          return {
            scorecardId: sid,
            grossScore: gs,
            playerGrossScore: pgs,
            hasConflict: gs != null && gs > 0 && pgs != null && pgs !== gs,
            version: saved ? Number(saved.version || 1) : 0,
            stablefordPoints: saved && saved.stableford_points !== null ? Number(saved.stableford_points) : null,
            playerStablefordPoints: psp,
            stablefordTotal: Number(cumulative.stablefordTotal || 0),
            stablefordRelative: Number(cumulative.stablefordTotal || 0) - (Number(cumulative.holesPlayed || 0) * 2),
            holesPlayed: Number(cumulative.holesPlayed || 0),
            playerStablefordTotal: Number(cumulative.playerStablefordTotal || 0),
            playerStablefordRelative: Number(cumulative.playerStablefordTotal || 0) - (Number(cumulative.playerHolesPlayed || 0) * 2),
            ownerUserId: saved?.owner_user_id ? Number(saved.owner_user_id) : null
          };
        });

        return res.json({ holeNumber, scores });
      }
      // ── End lean path ─────────────────────────────────────────────────────

      // Lazy-warm the module cache on first request after a process restart.
      // isRoundCacheWarm is a pure Map scan — no DB cost when already warm.
      if (!isRoundCacheWarm(scorecard.tour_id, scorecard.round_number)) {
        await warmRoundCourseCache(db, scorecard.tour_id, scorecard.round_number);
      }

      // Fetch target group and hole config in parallel; reuse the group for the
      // permission check so getGroupEntriesForHole doesn't fetch it a second time.
      const [targetGroup, holeConfig] = await Promise.all([
        scorecard.type === 'individual'
          ? getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, scorecard.user_id)
          : null,
        getHoleConfig(db, scorecard.tour_id, scorecard.round_number, holeNumber),
      ]);
      if (!holeConfig) return res.status(400).json({ error: 'Hole configuration missing' });

      if (!canEditAllScores(req.tenantMembership?.role)) {
        if (scorecard.type === 'individual') {
          const requesterGroup = await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, req.session.user.id);
          if (!requesterGroup || !targetGroup || requesterGroup.id !== targetGroup.id) {
            return res.status(403).json({ error: 'Not allowed' });
          }
        } else {
          const requesterGroup = await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, req.session.user.id);
          if (!requesterGroup) return res.status(403).json({ error: 'Not allowed' });
        }
      }

      const context =
        scorecard.type === 'individual'
          ? await getGroupEntriesForHole(db, scorecard, holeConfig, targetGroup)
          : await getAmbroseEntriesForHole(db, scorecard, holeConfig);

      return res.json({
        mode: scorecard.type === 'team' ? 'ambrose' : 'individual',
        holeNumber,
        hole: {
          par: holeConfig.par,
          strokeIndexPrimary: holeConfig.stroke_index_primary,
          strokeIndexSecondary: holeConfig.stroke_index_secondary
        },
        entries: context.entries,
        ambroseContext: context.ambroseContext || null,
        individualContext: context.individualContext || null
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/api/live/:scorecardId/round-scores', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).json({ error: 'Scorecard not found' });

      if (!canEditAllScores(req.tenantMembership?.role)) {
        const requesterGroup = await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, req.session.user.id);
        const targetGroup = scorecard.type === 'individual'
          ? await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, scorecard.user_id)
          : requesterGroup;
        if (!requesterGroup || !targetGroup || requesterGroup.id !== targetGroup.id) {
          return res.status(403).json({ error: 'Not allowed' });
        }
      }

      const rows = await db('scorecard_holes')
        .where({ scorecard_id: scorecardId })
        .orderBy('hole_number')
        .select('hole_number', 'gross_score', 'stableford_points', 'player_gross_score');

      return res.json({
        scorecardId,
        holes: rows.map((r) => {
          const gs = r.gross_score !== null ? Number(r.gross_score) : null;
          const pgs = r.player_gross_score !== null ? Number(r.player_gross_score) : null;
          return {
            holeNumber: Number(r.hole_number),
            grossScore: gs,
            playerGrossScore: pgs,
            hasConflict: gs != null && gs > 0 && pgs != null && pgs !== gs,
            stablefordPoints: r.stableford_points !== null ? Number(r.stableford_points) : null,
          };
        })
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/api/live/:scorecardId/two-ball-status', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).json({ error: 'Scorecard not found' });

      const [round, teeGroup] = await Promise.all([
        db('golf_rounds').where({ tour_id: scorecard.tour_id, round_number: scorecard.round_number }).first(),
        getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, scorecard.user_id),
      ]);

      if (!round?.two_ball_enabled) return res.status(400).json({ error: 'Two-ball not enabled' });
      if (!teeGroup) return res.status(404).json({ error: 'Tee group not found' });

      if (!canEditAllScores(req.tenantMembership?.role)) {
        const requesterGroup = await getTeeGroupForUser(db, scorecard.tour_id, scorecard.round_number, req.session.user.id);
        if (!requesterGroup || requesterGroup.id !== teeGroup.id) {
          return res.status(403).json({ error: 'Not allowed' });
        }
      }

      const startingHole = Number(teeGroup.starting_hole || 1);
      const holeOrder = holeSequenceFrom(startingHole);

      // Group members with positions
      const groupMembers = await db('tee_group_players as tgp')
        .join('users as u', 'u.id', 'tgp.user_id')
        .where({ 'tgp.tee_group_id': teeGroup.id })
        .orderBy('tgp.position')
        .select('u.id as user_id', 'u.first_name', 'u.last_name', 'tgp.position');

      const groupSize = groupMembers.length;
      const twoBallType = round.two_ball_type || 'best_ball';
      const userIds = groupMembers.map((m) => Number(m.user_id));

      // Scorecards for each member
      const cards = await db('scorecards')
        .where({ tour_id: scorecard.tour_id, round_number: scorecard.round_number, type: 'individual' })
        .whereIn('user_id', userIds)
        .select('id', 'user_id');
      const cardByUser = new Map(cards.map((c) => [Number(c.user_id), Number(c.id)]));

      const membersWithCard = groupMembers.map((m) => ({
        ...m,
        user_id: Number(m.user_id),
        scorecard_id: cardByUser.get(Number(m.user_id)) || null,
      }));

      // Hole scores for all group scorecards
      const groupCardIds = membersWithCard.map((m) => m.scorecard_id).filter(Boolean);
      const holeRows = groupCardIds.length
        ? await db('scorecard_holes')
            .whereIn('scorecard_id', groupCardIds)
            .select('scorecard_id', 'hole_number', 'stableford_points')
        : [];
      const scoreByCard = {};
      for (const row of holeRows) {
        const cId = String(row.scorecard_id);
        if (!scoreByCard[cId]) scoreByCard[cId] = {};
        scoreByCard[cId][Number(row.hole_number)] = row.stableford_points !== null ? Number(row.stableford_points) : null;
      }

      // Team assignment
      let teamAMembers, teamBMembers;
      if (groupSize === 3) {
        const [tourHcps, roundHcps] = await Promise.all([
          db('player_handicaps').where({ tour_id: scorecard.tour_id }).whereIn('user_id', userIds).select('user_id', 'playing_handicap'),
          db('player_day_handicaps').where({ tour_id: scorecard.tour_id, round_number: scorecard.round_number }).whereIn('user_id', userIds).select('user_id', 'handicap_index'),
        ]);
        const tourMap = new Map(tourHcps.map((h) => [Number(h.user_id), Number(h.playing_handicap || 0)]));
        const roundMap = new Map(roundHcps.map((h) => [Number(h.user_id), Number(h.handicap_index)]));
        const withHcp = membersWithCard.map((m) => ({
          ...m,
          hcp: roundMap.has(m.user_id) ? roundMap.get(m.user_id) : (tourMap.get(m.user_id) || 0),
        }));
        const sorted = [...withHcp].sort((a, b) => a.hcp - b.hcp);
        const shared = sorted[0];
        const others = sorted.slice(1);
        teamAMembers = [others[0], shared];
        teamBMembers = [others[1], shared];
      } else {
        const byPos = new Map(membersWithCard.map((m) => [Number(m.position), m]));
        teamAMembers = [byPos.get(1), byPos.get(2)].filter(Boolean);
        teamBMembers = [byPos.get(3), byPos.get(4)].filter(Boolean);
      }

      function teamHoleScore(members, holeNumber) {
        const pts = members
          .map((m) => (m.scorecard_id ? (scoreByCard[String(m.scorecard_id)]?.[holeNumber] ?? null) : null))
          .filter((s) => s !== null);
        if (!pts.length) return null;
        return twoBallType === 'best_ball' ? Math.max(...pts) : pts.reduce((a, b) => a + b, 0);
      }

      // Out/In split — first 9 and second 9 in play order
      const firstHalfHoles = holeOrder.slice(0, 9);
      const secondHalfHoles = holeOrder.slice(9);
      function halfTotal(members, holes) {
        return holes.reduce((sum, h) => sum + (teamHoleScore(members, h) ?? 0), 0);
      }

      // Match play hole by hole in play order
      let matchStatus = 0;
      const matchByHole = [];
      for (const h of holeOrder) {
        const a = teamHoleScore(teamAMembers, h);
        const b = teamHoleScore(teamBMembers, h);
        if (a === null || b === null) continue;
        const delta = a > b ? 1 : (b > a ? -1 : 0);
        matchStatus += delta;
        matchByHole.push({ holeNumber: h, teamA: a, teamB: b, holeDelta: delta, runningStatus: matchStatus });
      }

      const formatPlayers = (members) => members.map((m) => ({
        displayName: toPlayerLabel(m.first_name, m.last_name),
        scorecardId: m.scorecard_id,
        userId: Number(m.user_id),
      }));

      return res.json({
        twoBallType,
        groupSize,
        startingHole,
        holeOrder,
        teamA: {
          players: formatPlayers(teamAMembers),
          total: holeOrder.reduce((s, h) => s + (teamHoleScore(teamAMembers, h) ?? 0), 0),
        },
        teamB: {
          players: formatPlayers(teamBMembers),
          total: holeOrder.reduce((s, h) => s + (teamHoleScore(teamBMembers, h) ?? 0), 0),
        },
        firstHalf: { holes: firstHalfHoles, teamA: halfTotal(teamAMembers, firstHalfHoles), teamB: halfTotal(teamBMembers, firstHalfHoles) },
        secondHalf: { holes: secondHalfHoles, teamA: halfTotal(teamAMembers, secondHalfHoles), teamB: halfTotal(teamBMembers, secondHalfHoles) },
        match: { status: matchStatus, holesPlayed: matchByHole.length, byHole: matchByHole },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/api/live/gross', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.body.scorecardId);
      const holeNumber = Number(req.body.holeNumber);
      const grossScore = Number(req.body.grossScore);
      const opId = String(req.body.opId || '').trim();
      const rawBaseVersion = req.body.baseVersion;
      const hasBaseVersion = rawBaseVersion !== undefined && rawBaseVersion !== null && rawBaseVersion !== '';
      const baseVersion = hasBaseVersion ? Number(rawBaseVersion) : null;
      if (holeNumber < 1 || holeNumber > 18) return res.status(400).json({ error: 'Invalid hole' });
      if (!Number.isFinite(grossScore) || grossScore < 0 || grossScore > 20) {
        return res.status(400).json({ error: 'Invalid gross score' });
      }
      if (opId && opId.length > 120) return res.status(400).json({ error: 'Invalid operation id' });
      if (hasBaseVersion && (!Number.isFinite(baseVersion) || baseVersion < 0)) {
        return res.status(400).json({ error: 'Invalid base version' });
      }

      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).json({ error: 'Scorecard not found' });

      // Determine write target based on role relative to this scorecard.
      // When a marker is assigned: marker writes gross_score (authoritative);
      // the card owner writes player_gross_score (advisory audit trail).
      // When no marker is assigned: any group member writes gross_score (existing behaviour).
      const requesterId = Number(req.session.user.id);
      const markerUserId = scorecard.marked_by_user_id != null ? Number(scorecard.marked_by_user_id) : null;
      const cardOwnerId = scorecard.user_id != null ? Number(scorecard.user_id) : null;
      const isAdmin = canEditAllScores(req.tenantMembership?.role);

      let writeTarget; // 'marker' | 'player'
      if (isAdmin) {
        writeTarget = 'marker';
      } else if (markerUserId != null) {
        if (requesterId === markerUserId) {
          writeTarget = 'marker';
        } else if (requesterId === cardOwnerId) {
          writeTarget = 'player';
        } else {
          return res.status(403).json({ error: 'Not allowed' });
        }
      } else {
        const permitted = await canUserEditScorecard(db, req.session.user, scorecard, req.tenantMembership?.role);
        if (!permitted) return res.status(403).json({ error: 'Not allowed' });
        writeTarget = 'marker';
      }

      // Round must be open regardless of write target.
      const roundStatus = await getOrCreateRoundStatus(db, scorecard.tour_id, scorecard.round_number);
      if (roundStatus.status !== 'open') {
        return res.status(409).json({ error: 'Scoring is not open for this round' });
      }

      // ── Player advisory path ──────────────────────────────────────────────
      if (writeTarget === 'player') {
        // Fetch hole config + handicap to compute advisory stableford points
        const [hole, roundHcp, tourHcp] = await Promise.all([
          getHoleConfig(db, scorecard.tour_id, scorecard.round_number, holeNumber),
          db('player_day_handicaps').where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id, round_number: scorecard.round_number }).first(),
          db('player_handicaps').where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id }).first(),
        ]);
        let playerStabPoints = null;
        if (hole && grossScore > 0) {
          const isHcpOverride = !!roundHcp;
          const idx = isHcpOverride ? Number(roundHcp.handicap_index) : (tourHcp ? Number(tourHcp.playing_handicap || 0) : 0);
          const ph = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx, null, null, isHcpOverride);
          playerStabPoints = stablefordPoints({
            grossScore,
            par: hole.par,
            strokeIndexPrimary: hole.stroke_index_primary,
            strokeIndexSecondary: hole.stroke_index_secondary,
            playingHandicap: ph
          }).points;
        }

        const existing = await db('scorecard_holes')
          .where({ scorecard_id: scorecardId, hole_number: holeNumber })
          .first();
        if (existing) {
          await db('scorecard_holes')
            .where({ id: existing.id })
            .update({ player_gross_score: grossScore, player_stableford_points: playerStabPoints, updated_at: db.fn.now() });
        } else {
          await db('scorecard_holes').insert({
            scorecard_id: scorecardId, hole_number: holeNumber, player_gross_score: grossScore, player_stableford_points: playerStabPoints,
          });
        }
        const row = await db('scorecard_holes')
          .where({ scorecard_id: scorecardId, hole_number: holeNumber })
          .first();
        const gs = row?.gross_score != null ? Number(row.gross_score) : null;
        const pgs = row?.player_gross_score != null ? Number(row.player_gross_score) : null;
        const hasConflict = gs != null && gs > 0 && pgs != null && pgs !== gs;
        return res.json({
          ok: true,
          writeTarget: 'player',
          grossScore: gs,
          playerGrossScore: pgs,
          playerStablefordPoints: row?.player_stableford_points != null ? Number(row.player_stableford_points) : null,
          hasConflict,
          stableford: row?.stableford_points != null ? Number(row.stableford_points) : null,
          holeVersion: row?.version != null ? Number(row.version) : 1,
        });
      }

      // ── Marker authoritative path ─────────────────────────────────────────
      const isIndividual = scorecard.type === 'individual';
      const [hole, roundHcp, tourHcp] = await Promise.all([
        getHoleConfig(db, scorecard.tour_id, scorecard.round_number, holeNumber),
        isIndividual
          ? db('player_day_handicaps').where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id, round_number: scorecard.round_number }).first()
          : Promise.resolve(null),
        isIndividual
          ? db('player_handicaps').where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id }).first()
          : Promise.resolve(null),
      ]);
      if (!hole) return res.status(400).json({ error: 'Hole configuration missing' });

      let playingHandicap = 0;
      if (isIndividual) {
        const isHcpOverride = !!roundHcp;
        const idx = isHcpOverride ? Number(roundHcp.handicap_index) : (tourHcp ? Number(tourHcp.playing_handicap || 0) : 0);
        playingHandicap = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx, null, null, isHcpOverride);
      } else if (scorecard.type === 'team') {
        const teamHcp = await getTeamHandicapInfo(db, scorecard);
        playingHandicap = teamHcp.wholeShots;
      }

      const result = await upsertHoleScore(db, {
        scorecardId,
        holeNumber,
        grossScore,
        par: hole.par,
        strokeIndexPrimary: hole.stroke_index_primary,
        strokeIndexSecondary: hole.stroke_index_secondary,
        playingHandicap,
        scorecardEventId: scorecard.tour_id,
        requesterUserId: req.session.user.id,
        force: canEditAllScores(req.tenantMembership?.role),
        opId,
        baseVersion
      });

      markLeaderboardDirty(db, scorecard.tour_id).catch(() => {});

      // Include player advisory score and conflict state in the response so the
      // UI can update the conflict indicator without a separate fetch.
      const row = await db('scorecard_holes')
        .where({ scorecard_id: scorecardId, hole_number: holeNumber })
        .select('player_gross_score')
        .first();
      const pgs = row?.player_gross_score != null ? Number(row.player_gross_score) : null;
      const gs = Number(result.grossScore);
      const hasConflict = gs > 0 && pgs != null && pgs !== gs;

      return res.json({
        ok: true,
        writeTarget: 'marker',
        stableford: result.points,
        grossScore: gs,
        playerGrossScore: pgs,
        hasConflict,
        holeVersion: Number(result.version || 0),
        opId: result.opId || null
      });
    } catch (error) {
      if (error instanceof ScoreConflictError) {
        return res.status(409).json({
          error: 'conflict',
          message: 'Conflict: server score differs from your entry',
          ...error.payload
        });
      }
      return next(error);
    }
  });

  router.post('/api/live/drive', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.body.scorecardId);
      const holeNumber = Number(req.body.holeNumber);
      const rawDriveTakenUserId = req.body.driveTakenUserId;
      const clearDrive =
        rawDriveTakenUserId === null ||
        rawDriveTakenUserId === '' ||
        Number(rawDriveTakenUserId) === 0;
      const driveTakenUserId = clearDrive ? null : Number(rawDriveTakenUserId);
      if (holeNumber < 1 || holeNumber > 18) return res.status(400).json({ error: 'Invalid hole' });

      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).json({ error: 'Scorecard not found' });
      if (scorecard.type !== 'team') return res.status(400).json({ error: 'Drive tracking only applies to team scorecards' });
      if (scorecard.status === 'submitted' && !isAdmin(req)) {
        return res.status(409).json({ error: 'Scorecard has been submitted and is locked' });
      }

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard, req.tenantMembership?.role);
      if (!permitted) return res.status(403).json({ error: 'Not allowed' });
      const roundStatus = await getOrCreateRoundStatus(db, scorecard.tour_id, scorecard.round_number);
      if (roundStatus.status !== 'open') {
        return res.status(409).json({ error: 'Scoring is not open for this round' });
      }

      const existing = await db('ambrose_drives')
        .where({ scorecard_id: scorecardId, hole_number: holeNumber })
        .first();

      if (clearDrive) {
        if (existing) {
          await db('ambrose_drives').where({ id: existing.id }).del();
        }
        return res.json({ ok: true, cleared: true });
      }

      const member = await db('team_members')
        .where({ team_id: scorecard.team_id, user_id: driveTakenUserId })
        .first();
      if (!member) return res.status(400).json({ error: 'Selected player is not in this team' });

      if (existing) {
        await db('ambrose_drives')
          .where({ id: existing.id })
          .update({ drive_taken_user_id: driveTakenUserId, updated_at: db.fn.now() });
      } else {
        await db('ambrose_drives').insert({
          scorecard_id: scorecardId,
          hole_number: holeNumber,
          drive_taken_user_id: driveTakenUserId
        });
      }

      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:scorecardId/hole', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const holeNumber = Number(req.body.holeNumber);
      const grossScore = Number(req.body.grossScore);
      if (holeNumber < 1 || holeNumber > 18) return res.status(400).send('Invalid hole');
      if (!Number.isFinite(grossScore) || grossScore < 0 || grossScore > 20) return res.status(400).send('Invalid gross score');

      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).send('Scorecard not found');
      if (scorecard.status === 'submitted' && !isAdmin(req)) {
        return res.status(409).send('Scorecard has been submitted and is locked');
      }

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard, req.tenantMembership?.role);
      if (!permitted) return res.status(403).send('Not allowed');
      const roundStatus = await getOrCreateRoundStatus(db, scorecard.tour_id, scorecard.round_number);
      if (roundStatus.status !== 'open') return res.status(409).send('Scoring is not open for this round');

      const hole = await getHoleConfig(db, scorecard.tour_id, scorecard.round_number, holeNumber);
      if (!hole) return res.status(400).send('Hole configuration missing');

      let playingHandicap = 0;
      if (scorecard.type === 'individual') {
        const roundHcp = await db('player_day_handicaps').where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id, round_number: scorecard.round_number }).first();
        const tourHcp = await db('player_handicaps').where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id }).first();
        const idx = roundHcp ? Number(roundHcp.handicap_index) : (tourHcp ? Number(tourHcp.playing_handicap || 0) : 0);
        playingHandicap = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx);
      } else if (scorecard.type === 'team') {
        const teamHcp = await getTeamHandicapInfo(db, scorecard);
        playingHandicap = teamHcp.wholeShots;
      }

      await upsertHoleScore(db, {
        scorecardId,
        holeNumber,
        grossScore,
        par: hole.par,
        strokeIndexPrimary: hole.stroke_index_primary,
        strokeIndexSecondary: hole.stroke_index_secondary,
        playingHandicap,
        scorecardEventId: scorecard.tour_id,
        requesterUserId: req.session.user.id,
        force: canEditAllScores(req.tenantMembership?.role)
      });

      return res.redirect(res.locals.tenantPath('/scoring'));
    } catch (error) {
      if (error instanceof ScoreConflictError) {
        return res.status(409).send('Conflict: server score differs from your entry');
      }
      return next(error);
    }
  });

  return router;
}

module.exports = { scoringRouter };
