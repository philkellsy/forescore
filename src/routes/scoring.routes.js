'use strict';

const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { defaultCalcTypeForDay } = require('../config/calc-types');
const { canEditAllScores } = require('../services/permissions/scoring-permissions.service');
const { upsertHoleScore, ScoreConflictError } = require('../services/scoring/score-entry.service');
const { stablefordPoints } = require('../services/scoring/stableford.service');
const { markLeaderboardDirty } = require('../services/leaderboard/dirty.service');
const { TEST_TENANT_ID } = require('../config/constants');
const { dayLabel } = require('../services/events/day-label.service');
const { computeCourseHandicap, getCachedCourseData, getCachedParByHole, warmRoundCourseCache, isRoundCacheWarm } = require('../services/scoring/handicap.service');

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
    const idx = m.round_handicap_index != null ? Number(m.round_handicap_index) : Number(m.playing_handicap || 0);
    return getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx);
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
    const tour = await db('tours').where({ id: tourId }).first();
    const defaultCourse = await db('courses')
      .where(tour?.tenant_id === TEST_TENANT_ID ? {} : { tenant_id: tour?.tenant_id })
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

async function getCourseHandicapForRound(db, tourId, roundNumber, handicapIndex, gender = null, _reqCache = null) {
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
      return computeCourseHandicap(handicapIndex, moduleCached.slope, moduleCached.rating, moduleCached.par);
    }

    // Fallback: round is still draft or cache missed (e.g. first boot) — query DB.
    const course = await db('courses').where({ id: courseId }).first();
    if (!course) { _reqCache?.set(reqCacheKey, null); return Math.round(Number(handicapIndex) || 0); }
    const coursePar = await db('holes').where({ course_id: courseId }).sum({ total: 'par' }).first();
    cached = { course, coursePar };
    _reqCache?.set(reqCacheKey, cached);
  }
  if (!cached) return Math.round(Number(handicapIndex) || 0);
  return computeCourseHandicap(handicapIndex, cached.course.slope_rating, cached.course.course_rating, cached.coursePar?.total || 72);
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
    .select('scorecard_id', 'hole_number', 'gross_score', 'stableford_points');

  const byScorecard = new Map();
  for (const row of rows) {
    const sId = Number(row.scorecard_id);
    if (!byScorecard.has(sId)) {
      byScorecard.set(sId, {
        holesPlayed: 0,
        grossTotal: 0,
        parTotal: 0,
        stablefordTotal: 0
      });
    }
    const target = byScorecard.get(sId);
    const hole = Number(row.hole_number);
    target.holesPlayed += 1;
    target.grossTotal += Number(row.gross_score || 0);
    target.parTotal += Number(parByHole.get(hole) || 0);
    target.stablefordTotal += Number(row.stableford_points || 0);
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
  const rows = await db('scorecard_holes')
    .whereIn('scorecard_id', scorecardIds)
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
    .select('scorecard_id', 'hole_number', 'gross_score', 'stableford_points')
    .orderBy([{ column: 'hole_number', order: 'asc' }, { column: 'scorecard_id', order: 'asc' }]);

  for (const row of rows) {
    const scorecardId = Number(row.scorecard_id);
    if (!summaries.has(scorecardId)) summaries.set(scorecardId, new Map());
    summaries.get(scorecardId).set(Number(row.hole_number), {
      grossScore: Number(row.gross_score),
      stablefordPoints:
        row.stableford_points === null || row.stableford_points === undefined
          ? null
          : Number(row.stableford_points)
    });
  }

  return summaries;
}

async function buildConfirmationData(db, scorecard) {
  const holeConfig = await getHoleConfig(db, scorecard.tour_id, scorecard.round_number, 1);
  if (!holeConfig) return { mode: scorecard.type === 'team' ? 'ambrose' : 'individual', entries: [], hasMissing: true };

  const context =
    scorecard.type === 'individual'
      ? await getGroupEntriesForHole(db, scorecard, holeConfig)
      : await getAmbroseEntriesForHole(db, scorecard, holeConfig);

  const entryCards = context.entries || [];
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

  const hasMissing = entries.some((entry) => (entry.missingHoles || []).length > 0);
  const holes = [];
  for (let holeNumber = 1; holeNumber <= 18; holeNumber += 1) {
    holes.push({
      holeNumber,
      cells: entries.map((entry) => {
        const scorecardId = Number(entry.scorecardId);
        const holeSummary = holeSummariesByCard.get(scorecardId)?.get(holeNumber) || null;
        const grossScore = holeSummary ? Number(holeSummary.grossScore) : null;
        const stablefordPoints =
          holeSummary && holeSummary.stablefordPoints !== null && holeSummary.stablefordPoints !== undefined
            ? Number(holeSummary.stablefordPoints)
            : null;
        return {
          scorecardId,
          grossScore,
          stablefordPoints,
          missing: !holeSummary,
          displayScore: holeSummary ? String(grossScore) : '–'
        };
      })
    });
  }

  return {
    mode: scorecard.type === 'team' ? 'ambrose' : 'individual',
    entries,
    holes,
    hasMissing
  };
}

async function canUserEditScorecard(db, requester, scorecard) {
  if (canEditAllScores(requester)) return true;
  if (scorecard.type === 'individual') {
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
    const handicapIndex = roundHcp ? Number(roundHcp.handicap_index) : (tourHcp ? Number(tourHcp.playing_handicap || 0) : 0);
    const playingHandicap = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, handicapIndex);

    const saved = await db('scorecard_holes')
      .where({ scorecard_id: scorecard.id, hole_number: holeConfig.hole_number })
      .first();
    const grossScore = saved ? Number(saved.gross_score) : null;
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
          holeVersion: saved ? Number(saved.version || 1) : 0,
          stableford,
          stablefordTotal: stableford === null ? 0 : stableford,
          stablefordRelative: stableford === null ? 0 : stableford - 2
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
  const handicapIndexByUser = new Map(playerIds.map((uid) => [uid, roundHcpByUser.has(uid) ? roundHcpByUser.get(uid) : (tourHcpByUser.get(uid) || 0)]));
  const genderByUser = new Map(playerGenderRows.map((r) => [Number(r.id), r.gender]));
  const handicapByUser = new Map(
    await Promise.all(playerIds.map(async (uid) => [uid, await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, handicapIndexByUser.get(uid), genderByUser.get(uid) || null)]))
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
    .select('s.user_id', 'sh.gross_score', 'sh.stableford_points', 'sh.version');
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
        stablefordTotal: 0
      };
      const stablefordTotal = Number(cumulative.stablefordTotal || 0);
      const stablefordRelative = stablefordTotal - (Number(cumulative.holesPlayed || 0) * 2);

      return {
        type: 'player',
        scorecardId,
        participantId: userId,
        displayName: toPlayerLabel(p.first_name, p.last_name),
        fullName: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        playingHandicap,
        handicapDisplay: formatHandicapDisplay(playingHandicap),
        grossScore,
        holeVersion: saved ? Number(saved.version || 1) : 0,
        stableford,
        stablefordTotal,
        stablefordRelative
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
    const idx = m.round_handicap_index != null ? Number(m.round_handicap_index) : Number(m.playing_handicap || 0);
    const courseHcp = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx);
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
          const idx = roundHcp ? Number(roundHcp.handicap_index) : (tourHcp ? Number(tourHcp.playing_handicap || 0) : 0);
          const courseHcp = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx, scorecard.user_gender || null, hcpCache);
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
            .where({ 'tg.tour_id': scorecard.tour_id, 'tg.round_number': scorecard.round_number })
            .whereNot('peers.user_id', scorecard.user_id)
            .select('u.first_name', 'u.last_name', 'u.gender', 'ph.playing_handicap', 'pdh.handicap_index as round_handicap_index')
            .orderBy('u.first_name', 'asc');
          otherPlayers = await Promise.all(rawOtherPlayers.map(async (p) => {
            const idx = p.round_handicap_index != null ? Number(p.round_handicap_index) : Number(p.playing_handicap || 0);
            const courseHcp = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx, p.gender || null, hcpCache);
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
            const idx = p.round_handicap_index != null ? Number(p.round_handicap_index) : Number(p.playing_handicap || 0);
            const courseHcp = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx, null, hcpCache);
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

        const confirmation = await buildConfirmationData(db, scorecard);
        const submittedSummary =
          scorecard.status === 'submitted'
            ? confirmation.entries.map((entry) =>
                entry.type === 'team'
                  ? {
                      label: entry.displayName,
                      value: `Net ${entry.netTotalDisplay || Number(entry.netTotalRaw || 0)}`,
                      detail: `Gross ${Number(entry.grossTotal || 0)} - Hcp ${entry.teamHandicapDisplay || Number(entry.teamHandicapRaw || 0)}`
                    }
                  : {
                      label: entry.displayName,
                      value: `${Number(entry.stablefordTotal || 0)} pts`,
                      detail: null
                    }
              )
            : [];

        return {
          ...scorecard,
          ambroseTeamHandicapDisplay,
          ambroseOtherTeams,
          ownHandicapDisplay,
          submittedSummary,
          otherPlayers: otherPlayers.map((p) => ({
            fullName: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
            handicapDisplay: formatHandicapDisplay(p.playing_handicap)
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
      dayLabel
    });
  });

  router.get('/live/:scorecardId', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).send('Scorecard not found');

      const [permitted, roundStatus] = await Promise.all([
        canUserEditScorecard(db, req.session.user, scorecard),
        getOrCreateRoundStatus(db, scorecard.tour_id, scorecard.round_number),
      ]);
      if (!permitted) return res.status(403).send('Not allowed');

      // Minimal payload — client calls /api/live/:id/init for all static context.
      const payload = {
        mode: scorecard.type === 'team' ? 'ambrose' : 'individual',
        scorecardId: scorecard.id,
        tourId: scorecard.tour_id,
        roundNumber: scorecard.round_number,
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

  router.get('/confirm/:scorecardId', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).send('Scorecard not found');

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard);
      if (!permitted) return res.status(403).send('Not allowed');

      const confirmation = await buildConfirmationData(db, scorecard);

      return res.render('scorer/confirm', {
        title: 'Review Scores',
        user: req.session.user,
        scorecard,
        confirmation,
        canSubmit: scorecard.status !== 'submitted' && !confirmation.hasMissing,
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

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard);
      if (!permitted) return res.status(403).send('Not allowed');

      const confirmation = await buildConfirmationData(db, scorecard);
      if (scorecard.status !== 'submitted' && confirmation.hasMissing) {
        return res.redirect(res.locals.tenantPath(`/scoring/confirm/${scorecardId}`));
      }

      const canSubmit = scorecard.status !== 'submitted' && !confirmation.hasMissing;
      const groupScorecardIds = [...new Set(
        (confirmation.entries || [])
          .map((entry) => Number(entry.scorecardId))
          .filter((id) => Number.isFinite(id))
      )];
      const submitSnapshot = await buildGroupSnapshot(db, groupScorecardIds);

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

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard);
      if (!permitted) return res.status(403).send('Not allowed');
      if (scorecard.status === 'submitted') {
        return res.status(409).json({
          error: 'already_finalized',
          redirect: res.locals.tenantPath('/scoring?message=Scores%20already%20finalised')
        });
      }

      const confirmation = await buildConfirmationData(db, scorecard);
      if (confirmation.hasMissing) {
        return res.status(409).json({
          error: 'missing_scores',
          message: 'All holes must be scored before submission.'
        });
      }

      const groupScorecardIds = [...new Set(
        (confirmation.entries || [])
          .map((entry) => Number(entry.scorecardId))
          .filter((id) => Number.isFinite(id))
      )];
      if (!groupScorecardIds.length) {
        return res.status(409).json({
          error: 'missing_scores',
          message: 'No scorecards found to submit.'
        });
      }

      const submittedSnapshot = String(req.body?.submitSnapshot || '').trim();
      const currentSnapshot = await buildGroupSnapshot(db, groupScorecardIds);
      if (!submittedSnapshot || submittedSnapshot !== currentSnapshot) {
        return res.status(409).json({
          error: 'stale_scores',
          message: 'Scores changed since confirmation. Please review conflicts before submitting.',
          redirect: res.locals.tenantPath(`/scoring/confirm/${scorecardId}?error=stale_scores`)
        });
      }

      const updated = await db('scorecards')
        .whereIn('id', groupScorecardIds)
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
        redirect: res.locals.tenantPath('/scoring?message=Group%20scores%20submitted%20successfully')
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
      if (!canEditAllScores(req.session.user)) {
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
            .select('id', 'user_id');
          const scorecardByUser = new Map(existingCards.map((r) => [Number(r.user_id), Number(r.id)]));
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
              const hcpIndex = roundHcpByUser.has(uid) ? roundHcpByUser.get(uid) : (tourHcpByUser.get(uid) || 0);
              const gender = genderByUser.get(uid) || null;
              return [uid, await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, hcpIndex, gender)];
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
              courseId: round ? resolvePlayerCourseId(round, genderByUser.get(uid) || null) : null
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
            const hcpIndex = roundHcp ? Number(roundHcp.handicap_index) : (tourHcp ? Number(tourHcp.playing_handicap || 0) : 0);
            const playingHandicap = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, hcpIndex, player.gender || null);
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

      return res.json({
        mode: scorecard.type === 'team' ? 'ambrose' : 'individual',
        scorecardId: Number(scorecard.id),
        currentUserId: Number(req.session.user.id),
        startingHole,
        currentHole,
        holeOrder,
        requesterDisplay: toPlayerLabel(
          req.session.user.firstName || req.session.user.first_name || '',
          req.session.user.lastName || req.session.user.last_name || ''
        ),
        individualContext,
        players,
        holes,
        femaleHoles,
        primaryCourseId,
        femaleCourseId,
        scorecardIds
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
        if (!canEditAllScores(req.session.user)) {
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
            .select('scorecard_id', 'gross_score', 'stableford_points', 'version', 'owner_user_id'),
          getCumulativeByScorecard(db, sids, windowHoles, parByHole),
        ]);

        const holeScoreByCard = new Map(holeScores.map((r) => [Number(r.scorecard_id), r]));
        const scores = sids.map((sid) => {
          const saved = holeScoreByCard.get(sid);
          const cumulative = cumulativeByScorecard.get(sid) || { holesPlayed: 0, stablefordTotal: 0 };
          return {
            scorecardId: sid,
            grossScore: saved ? Number(saved.gross_score) : null,
            version: saved ? Number(saved.version || 1) : 0,
            stablefordPoints: saved && saved.stableford_points !== null ? Number(saved.stableford_points) : null,
            stablefordTotal: Number(cumulative.stablefordTotal || 0),
            stablefordRelative: Number(cumulative.stablefordTotal || 0) - (Number(cumulative.holesPlayed || 0) * 2),
            holesPlayed: Number(cumulative.holesPlayed || 0),
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

      if (!canEditAllScores(req.session.user)) {
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

      if (!canEditAllScores(req.session.user)) {
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
        .select('hole_number', 'gross_score', 'stableford_points');

      return res.json({
        scorecardId,
        holes: rows.map((r) => ({
          holeNumber: Number(r.hole_number),
          grossScore: r.gross_score !== null ? Number(r.gross_score) : null,
          stablefordPoints: r.stableford_points !== null ? Number(r.stableford_points) : null,
        }))
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

      const isIndividual = scorecard.type === 'individual';
      const [permitted, roundStatus, hole, roundHcp, tourHcp] = await Promise.all([
        canUserEditScorecard(db, req.session.user, scorecard),
        getOrCreateRoundStatus(db, scorecard.tour_id, scorecard.round_number),
        getHoleConfig(db, scorecard.tour_id, scorecard.round_number, holeNumber),
        isIndividual
          ? db('player_day_handicaps').where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id, round_number: scorecard.round_number }).first()
          : Promise.resolve(null),
        isIndividual
          ? db('player_handicaps').where({ tour_id: scorecard.tour_id, user_id: scorecard.user_id }).first()
          : Promise.resolve(null),
      ]);

      if (!permitted) return res.status(403).json({ error: 'Not allowed' });
      if (roundStatus.status !== 'open') {
        return res.status(409).json({ error: 'Scoring is not open for this round' });
      }
      if (!hole) return res.status(400).json({ error: 'Hole configuration missing' });

      let playingHandicap = 0;
      if (isIndividual) {
        const idx = roundHcp ? Number(roundHcp.handicap_index) : (tourHcp ? Number(tourHcp.playing_handicap || 0) : 0);
        playingHandicap = await getCourseHandicapForRound(db, scorecard.tour_id, scorecard.round_number, idx);
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

      return res.json({
        ok: true,
        stableford: result.points,
        grossScore: result.grossScore,
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

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard);
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

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard);
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
