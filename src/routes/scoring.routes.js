'use strict';

const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { defaultCalcTypeForDay } = require('../config/calc-types');
const { canEditAllScores } = require('../services/permissions/scoring-permissions.service');
const { upsertHoleScore, ScoreConflictError } = require('../services/scoring/score-entry.service');
const { stablefordPoints } = require('../services/scoring/stableford.service');
const { markLeaderboardDirty } = require('../services/leaderboard/dirty.service');

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
  // Part-shots do not allocate an extra stroke.
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
      this.on('ph.user_id', '=', 'tm.user_id').andOnVal('ph.event_id', '=', scorecard.event_id);
    })
    .where({ 'tm.team_id': scorecard.team_id })
    .select('tm.user_id', 'ph.playing_handicap');

  const count = members.length;
  const allowance = ambroseAllowance(count);
  const total = members.reduce((sum, m) => sum + Number(m.playing_handicap || 0), 0);
  const raw = total * allowance;
  const wholeShots = toWholeShots(raw);

  return {
    memberCount: count,
    allowance,
    raw,
    wholeShots
  };
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

async function getHoleConfig(db, eventId, day, holeNumber) {
  return db('holes as h')
    .join('event_day_statuses as eds', 'eds.course_id', 'h.course_id')
    .where({ 'eds.event_id': eventId, 'eds.day': day, 'h.hole_number': holeNumber })
    .select('h.hole_number', 'h.par', 'h.stroke_index_primary', 'h.stroke_index_secondary')
    .first();
}

async function getTeeGroupForUser(db, eventId, day, userId) {
  return db('tee_groups as tg')
    .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
    .where({ 'tg.event_id': eventId, 'tg.day': day, 'tgp.user_id': userId })
    .select('tg.id', 'tg.starting_hole', 'tg.group_number', 'tg.tee_time', 'tg.tee_location')
    .first();
}

async function getTeeGroupPlayers(db, teeGroupId) {
  return db('tee_group_players as tgp')
    .join('users as u', 'u.id', 'tgp.user_id')
    .where({ 'tgp.tee_group_id': teeGroupId })
    .orderBy('tgp.position', 'asc')
    .select('u.id', 'u.first_name', 'u.last_name', 'u.is_previous_winner');
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

function isAdmin(user) {
  return Boolean(user && user.role === 'admin');
}

async function getParByHole(db, eventId, day) {
  const rows = await db('holes as h')
    .join('event_day_statuses as eds', 'eds.course_id', 'h.course_id')
    .where({ 'eds.event_id': eventId, 'eds.day': day })
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

async function ensureIndividualScorecard(db, eventId, day, userId) {
  const existing = await db('scorecards')
    .where({ event_id: eventId, day, type: 'individual', user_id: userId })
    .first();
  if (existing) return Number(existing.id);

  try {
    const ids = await db('scorecards').insert({
      event_id: eventId,
      day,
      type: 'individual',
      user_id: userId,
      status: 'draft'
    });
    return Number(Array.isArray(ids) ? ids[0] : ids);
  } catch (error) {
    // In case of race/unique index conflict, re-read the existing row.
    const fallback = await db('scorecards')
      .where({ event_id: eventId, day, type: 'individual', user_id: userId })
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
  const targetGroup = await getTeeGroupForUser(db, scorecard.event_id, scorecard.day, scorecard.user_id);
  if (!targetGroup) return { scorecardIds: [scorecard.id], startingHole: 1 };

  const players = await getTeeGroupPlayers(db, targetGroup.id);
  const scorecardIds = [];
  for (const p of players) {
    const sId = await ensureIndividualScorecard(db, scorecard.event_id, scorecard.day, Number(p.id));
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

async function buildConfirmationData(db, scorecard) {
  const holeConfig = await getHoleConfig(db, scorecard.event_id, scorecard.day, 1);
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
  return {
    mode: scorecard.type === 'team' ? 'ambrose' : 'individual',
    entries,
    hasMissing
  };
}

async function canUserEditScorecard(db, requester, scorecard) {
  if (canEditAllScores(requester)) return true;
  if (scorecard.type === 'individual') {
    const requesterGroup = await getTeeGroupForUser(db, scorecard.event_id, scorecard.day, requester.id);
    const targetGroup = await getTeeGroupForUser(db, scorecard.event_id, scorecard.day, scorecard.user_id);
    return Boolean(requesterGroup && targetGroup && requesterGroup.id === targetGroup.id);
  }

  const requesterGroup = await getTeeGroupForUser(db, scorecard.event_id, scorecard.day, requester.id);
  return Boolean(requesterGroup);
}

async function getGroupEntriesForHole(db, scorecard, holeConfig) {
  const targetGroup = await getTeeGroupForUser(db, scorecard.event_id, scorecard.day, scorecard.user_id);
  if (!targetGroup) {
    const player = await db('users')
      .where({ id: scorecard.user_id })
      .select('id', 'first_name', 'last_name', 'is_previous_winner')
      .first();
    if (!player) return { entries: [], startingHole: 1 };

    const handicap = await db('player_handicaps')
      .where({ event_id: scorecard.event_id, user_id: scorecard.user_id })
      .first();
    const playingHandicap = handicap ? Number(handicap.playing_handicap || 0) : 0;

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
          isPreviousWinner: Number(player.is_previous_winner) === 1,
          playingHandicap,
          handicapDisplay: formatHandicapDisplay(playingHandicap),
          grossScore,
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
  const scorecardByUser = new Map();
  for (const p of players) {
    const sId = await ensureIndividualScorecard(db, scorecard.event_id, scorecard.day, Number(p.id));
    scorecardByUser.set(Number(p.id), sId);
  }

  const handicaps = await db('player_handicaps')
    .where({ event_id: scorecard.event_id })
    .whereIn('user_id', playerIds)
    .select('user_id', 'playing_handicap');
  const handicapByUser = new Map(handicaps.map((h) => [h.user_id, Number(h.playing_handicap || 0)]));

  const holeScores = await db('scorecard_holes as sh')
    .join('scorecards as s', 's.id', 'sh.scorecard_id')
    .where({
      's.event_id': scorecard.event_id,
      's.day': scorecard.day,
      's.type': 'individual',
      'sh.hole_number': holeConfig.hole_number
    })
    .whereIn('s.user_id', playerIds)
    .select('s.user_id', 'sh.gross_score', 'sh.stableford_points');
  const holeScoreByUser = new Map(holeScores.map((row) => [row.user_id, row]));
  const scorecardIds = [...scorecardByUser.values()].filter((v) => Number.isFinite(Number(v))).map(Number);
  const parByHole = await getParByHole(db, scorecard.event_id, scorecard.day);
  const windowHoles = holesUpToCurrent(targetGroup.starting_hole, holeConfig.hole_number);
  const cumulativeByScorecard = await getCumulativeByScorecard(db, scorecardIds, windowHoles, parByHole);

  const entries = players
    .map((p) => {
      const userId = Number(p.id);
      const playingHandicap = handicapByUser.get(userId) || 0;
      const saved = holeScoreByUser.get(userId);
      const grossScore = saved ? Number(saved.gross_score) : null;
      const scorecardId = scorecardByUser.get(userId);
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
        isPreviousWinner: Number(p.is_previous_winner) === 1,
        playingHandicap,
        handicapDisplay: formatHandicapDisplay(playingHandicap),
        grossScore,
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
          event_id: scorecard.event_id,
          day: scorecard.day,
          competition_type: 'ambrose',
          ambrose_group_id: team.ambrose_group_id
        })
        .orderBy('id', 'asc')
        .select('id', 'name')
    : [{ id: team.id, name: team.name }];

  const teamIds = scopedTeams.map((t) => t.id);
  const scorecardRows = await db('scorecards')
    .where({
      event_id: scorecard.event_id,
      day: scorecard.day,
      type: 'team'
    })
    .whereIn('team_id', teamIds)
    .select('id', 'team_id');
  const scorecardByTeamId = new Map(scorecardRows.map((r) => [Number(r.team_id), Number(r.id)]));
  const scorecardIds = scorecardRows.map((r) => Number(r.id));

  const membersRows = await db('team_members as tm')
    .join('users as u', 'u.id', 'tm.user_id')
    .leftJoin('player_handicaps as ph', function joinPh() {
      this.on('ph.user_id', '=', 'u.id').andOnVal('ph.event_id', '=', scorecard.event_id);
    })
    .whereIn('tm.team_id', teamIds)
    .orderBy('u.first_name', 'asc')
    .select('tm.team_id', 'u.id', 'u.first_name', 'u.last_name', 'u.is_previous_winner', 'ph.playing_handicap');

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
        .select('scorecard_id', 'gross_score', 'stableford_points')
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

  const parByHole = await getParByHole(db, scorecard.event_id, scorecard.day);
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
      isPreviousWinner: Number(m.is_previous_winner) === 1,
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

    const ownScorecardIds = await db('scorecards')
      .where({ user_id: user.id, type: 'individual' })
      .pluck('id');

    const teamScorecardRows = await db('scorecards as s')
      .join('teams as t', 't.id', 's.team_id')
      .join('team_members as tm', function joinTm() {
        this.on('tm.team_id', '=', 't.id').andOnVal('tm.user_id', '=', user.id);
      })
      .where({ 's.type': 'team' })
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
        's.event_id',
        's.day',
        's.type',
        's.status',
        's.user_id',
        's.team_id',
        'u.first_name',
        'u.last_name',
        'u.is_previous_winner',
        't.ambrose_group_id',
        't.name as team_name',
        'ag.group_number as ambrose_group_number',
        'ag.tee_time as ambrose_tee_time',
        'ag.tee_location as ambrose_tee_location',
        'ag.starting_hole as ambrose_starting_hole',
        db.raw(`
          (
            SELECT eds.status
            FROM event_day_statuses eds
            WHERE eds.event_id = s.event_id AND eds.day = s.day
            LIMIT 1
          ) as day_status
        `),
        db.raw(`
          (
            SELECT tg.group_number
            FROM tee_groups tg
            JOIN tee_group_players tgp ON tgp.tee_group_id = tg.id
            WHERE tg.event_id = s.event_id
              AND tg.day = s.day
              AND tgp.user_id = s.user_id
            LIMIT 1
          ) as individual_group_number
        `),
        db.raw(`
          (
            SELECT tg.tee_time
            FROM tee_groups tg
            JOIN tee_group_players tgp ON tgp.tee_group_id = tg.id
            WHERE tg.event_id = s.event_id
              AND tg.day = s.day
              AND tgp.user_id = s.user_id
            LIMIT 1
          ) as individual_tee_time
        `),
        db.raw(`
          (
            SELECT tg.starting_hole
            FROM tee_groups tg
            JOIN tee_group_players tgp ON tgp.tee_group_id = tg.id
            WHERE tg.event_id = s.event_id
              AND tg.day = s.day
              AND tgp.user_id = s.user_id
            LIMIT 1
          ) as individual_starting_hole
        `)
      )
      .whereIn('s.id', [...scorecardIds])
      .orderBy([{ column: 's.day', order: 'asc' }, { column: 's.id', order: 'asc' }]);

    const enrichedScorecards = await Promise.all(
      scorecards.map(async (scorecard) => {
        let otherPlayers = [];
        let ambroseTeamHandicapDisplay = null;
        let ambroseOtherTeams = [];

        if (scorecard.type === 'individual' && scorecard.user_id) {
          otherPlayers = await db('tee_groups as tg')
            .join('tee_group_players as me', function joinMe() {
              this.on('me.tee_group_id', '=', 'tg.id').andOnVal('me.user_id', '=', scorecard.user_id);
            })
            .join('tee_group_players as peers', 'peers.tee_group_id', 'tg.id')
            .join('users as u', 'u.id', 'peers.user_id')
            .leftJoin('player_handicaps as ph', function joinPh() {
              this.on('ph.user_id', '=', 'u.id').andOnVal('ph.event_id', '=', scorecard.event_id);
            })
            .where({ 'tg.event_id': scorecard.event_id, 'tg.day': scorecard.day })
            .whereNot('peers.user_id', scorecard.user_id)
            .select('u.first_name', 'u.last_name', 'u.is_previous_winner', 'ph.playing_handicap')
            .orderBy('u.first_name', 'asc');
        }

        if (
          scorecard.type === 'team' &&
          scorecard.team_id &&
          scorecard.ambrose_group_id
        ) {
          otherPlayers = await db('teams as t2')
            .join('team_members as tm2', 'tm2.team_id', 't2.id')
            .join('users as u', 'u.id', 'tm2.user_id')
            .leftJoin('player_handicaps as ph', function joinPh() {
              this.on('ph.user_id', '=', 'u.id').andOnVal('ph.event_id', '=', scorecard.event_id);
            })
            .where({
              't2.event_id': scorecard.event_id,
              't2.day': scorecard.day,
              't2.competition_type': 'ambrose',
              't2.ambrose_group_id': scorecard.ambrose_group_id
            })
            .whereNot('t2.id', scorecard.team_id)
            .select('u.first_name', 'u.last_name', 'u.is_previous_winner', 'ph.playing_handicap')
            .orderBy('u.first_name', 'asc');

          const groupTeams = await db('teams')
            .where({
              event_id: scorecard.event_id,
              day: scorecard.day,
              competition_type: 'ambrose',
              ambrose_group_id: scorecard.ambrose_group_id
            })
            .select('id', 'name')
            .orderBy('id', 'asc');

          const teamIds = groupTeams.map((gt) => Number(gt.id));
          const memberRows = teamIds.length
            ? await db('team_members as tm')
                .leftJoin('player_handicaps as ph', function joinPh() {
                  this.on('ph.user_id', '=', 'tm.user_id').andOnVal('ph.event_id', '=', scorecard.event_id);
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
          submittedSummary,
          otherPlayers: otherPlayers.map((p) => ({
            fullName: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
            handicapDisplay: formatHandicapDisplay(p.playing_handicap),
            isPreviousWinner: Number(p.is_previous_winner) === 1
          }))
        };
      })
    );

    const orderedScorecards = [...enrichedScorecards].sort((a, b) => {
      const aActionableOpen = String(a.day_status || '') === 'open_scoring' && String(a.status || '') !== 'submitted';
      const bActionableOpen = String(b.day_status || '') === 'open_scoring' && String(b.status || '') !== 'submitted';
      if (aActionableOpen !== bActionableOpen) return aActionableOpen ? -1 : 1;

      const aSubmitted = String(a.status || '') === 'submitted';
      const bSubmitted = String(b.status || '') === 'submitted';
      if (aSubmitted !== bSubmitted) return aSubmitted ? 1 : -1;

      const dayDiff = Number(a.day || 0) - Number(b.day || 0);
      if (dayDiff !== 0) return dayDiff;

      return Number(a.id || 0) - Number(b.id || 0);
    });

    return res.render('scorer/index', {
      title: 'Scoring',
      user,
      scorecards: orderedScorecards,
      canEditAll: false,
      message
    });
  });

  router.get('/live/:scorecardId', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const requestedHole = Number(req.query.hole || 0);
      let holeNumber = requestedHole >= 1 && requestedHole <= 18 ? requestedHole : null;
      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).send('Scorecard not found');

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard);
      if (!permitted) return res.status(403).send('Not allowed');
      const dayStatus = await getOrCreateDayStatus(db, scorecard.event_id, scorecard.day);

      if (!holeNumber) {
        if (scorecard.type === 'team') {
          const team = await db('teams as t')
            .leftJoin('ambrose_groups as ag', 'ag.id', 't.ambrose_group_id')
            .where({ 't.id': scorecard.team_id })
            .select('ag.starting_hole')
            .first();
          const start = Number(team?.starting_hole || 1);
          holeNumber = await nextHoleForTeamScorecard(db, scorecard.id, start);
        } else {
          const groupCtx = await getIndividualGroupContext(db, scorecard);
          holeNumber = await nextHoleForIndividualGroup(db, scorecard, groupCtx.startingHole);
        }
      }

      const initialHole = holeNumber || 1;
      let holeConfig = await getHoleConfig(db, scorecard.event_id, scorecard.day, initialHole);
      if (!holeConfig) return res.status(400).send('Hole configuration missing');

      let context =
        scorecard.type === 'individual'
          ? await getGroupEntriesForHole(db, scorecard, holeConfig)
          : await getAmbroseEntriesForHole(db, scorecard, holeConfig);

      if (!holeNumber && Number(context.startingHole || 1) !== initialHole) {
        const startHole = Number(context.startingHole || 1);
        holeConfig = await getHoleConfig(db, scorecard.event_id, scorecard.day, startHole);
        if (!holeConfig) return res.status(400).send('Starting hole configuration missing');
        context =
          scorecard.type === 'individual'
            ? await getGroupEntriesForHole(db, scorecard, holeConfig)
            : await getAmbroseEntriesForHole(db, scorecard, holeConfig);
      }

      const payload = {
        mode: scorecard.type === 'team' ? 'ambrose' : 'individual',
        scorecardId: scorecard.id,
        eventId: scorecard.event_id,
        day: scorecard.day,
        requesterDisplay: toPlayerLabel(
          req.session.user.firstName || req.session.user.first_name || '',
          req.session.user.lastName || req.session.user.last_name || ''
        ),
        holeNumber: holeConfig.hole_number,
        startingHole: context.startingHole || 1,
        hole: {
          par: holeConfig.par,
          strokeIndexPrimary: holeConfig.stroke_index_primary,
          strokeIndexSecondary: holeConfig.stroke_index_secondary
        },
        entries: context.entries,
        ambroseContext: context.ambroseContext || null,
        individualContext: context.individualContext || null
      };

      return res.render('scorer/live', {
        title: 'Live Scorecard',
        user: req.session.user,
        payload,
        dayStatus
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/confirm/:scorecardId', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.params.scorecardId);
      const errorCode = String(req.query.error || '').trim();
      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).send('Scorecard not found');

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard);
      if (!permitted) return res.status(403).send('Not allowed');

      const confirmation = await buildConfirmationData(db, scorecard);
      const canSubmit = scorecard.status !== 'submitted' && !confirmation.hasMissing;
      const groupScorecardIds = [...new Set(
        (confirmation.entries || [])
          .map((entry) => Number(entry.scorecardId))
          .filter((id) => Number.isFinite(id))
      )];
      const submitSnapshot = await buildGroupSnapshot(db, groupScorecardIds);

      return res.render('scorer/confirm', {
        title: 'Submit Scorecard',
        user: req.session.user,
        scorecard,
        confirmation,
        canSubmit,
        submitError: null,
        submitSnapshot,
        staleScores: errorCode === 'stale_scores'
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
          redirect: '/scoring?message=Scores%20already%20finalised'
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
          redirect: `/scoring/confirm/${scorecardId}?error=stale_scores`
        });
      }

      const updated = await db('scorecards')
        .whereIn('id', groupScorecardIds)
        .whereNot({ status: 'submitted' })
        .update({ status: 'submitted', updated_at: db.fn.now() });

      if (!updated) {
        return res.status(409).json({
          error: 'already_finalized',
          redirect: '/scoring?message=Scores%20already%20finalised'
        });
      }

      await markLeaderboardDirty(db, scorecard.event_id);

      return res.json({
        ok: true,
        redirect: '/scoring?message=Group%20scores%20submitted%20successfully'
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
      if (scorecard.status === 'submitted' && !isAdmin(req.session.user)) {
        return res.status(409).json({ error: 'Scorecard has been submitted and is locked' });
      }

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard);
      if (!permitted) return res.status(403).json({ error: 'Not allowed' });

      const holeConfig = await getHoleConfig(db, scorecard.event_id, scorecard.day, holeNumber);
      if (!holeConfig) return res.status(400).json({ error: 'Hole configuration missing' });

      const context =
        scorecard.type === 'individual'
          ? await getGroupEntriesForHole(db, scorecard, holeConfig)
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

  router.post('/api/live/gross', requireAuth, async (req, res, next) => {
    try {
      const scorecardId = Number(req.body.scorecardId);
      const holeNumber = Number(req.body.holeNumber);
      const grossScore = Number(req.body.grossScore);
      if (holeNumber < 1 || holeNumber > 18) return res.status(400).json({ error: 'Invalid hole' });
      if (!Number.isFinite(grossScore) || grossScore < 0 || grossScore > 20) {
        return res.status(400).json({ error: 'Invalid gross score' });
      }

      const scorecard = await db('scorecards').where({ id: scorecardId }).first();
      if (!scorecard) return res.status(404).json({ error: 'Scorecard not found' });

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard);
      if (!permitted) return res.status(403).json({ error: 'Not allowed' });
      const dayStatus = await getOrCreateDayStatus(db, scorecard.event_id, scorecard.day);
      if (dayStatus.status !== 'open_scoring') {
        return res.status(409).json({ error: 'Scoring is not open for this day' });
      }

      const hole = await getHoleConfig(db, scorecard.event_id, scorecard.day, holeNumber);
      if (!hole) return res.status(400).json({ error: 'Hole configuration missing' });

      let playingHandicap = 0;
      if (scorecard.type === 'individual') {
        const handicap = await db('player_handicaps')
          .where({ event_id: scorecard.event_id, user_id: scorecard.user_id })
          .first();
        playingHandicap = handicap ? Number(handicap.playing_handicap || 0) : 0;
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
        scorecardEventId: scorecard.event_id,
        requesterUserId: req.session.user.id,
        force: canEditAllScores(req.session.user)
      });

      return res.json({ ok: true, stableford: result.points, grossScore: result.grossScore });
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
      if (scorecard.status === 'submitted' && !isAdmin(req.session.user)) {
        return res.status(409).json({ error: 'Scorecard has been submitted and is locked' });
      }

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard);
      if (!permitted) return res.status(403).json({ error: 'Not allowed' });
      const dayStatus = await getOrCreateDayStatus(db, scorecard.event_id, scorecard.day);
      if (dayStatus.status !== 'open_scoring') {
        return res.status(409).json({ error: 'Scoring is not open for this day' });
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
      if (scorecard.status === 'submitted' && !isAdmin(req.session.user)) {
        return res.status(409).send('Scorecard has been submitted and is locked');
      }

      const permitted = await canUserEditScorecard(db, req.session.user, scorecard);
      if (!permitted) return res.status(403).send('Not allowed');
      const dayStatus = await getOrCreateDayStatus(db, scorecard.event_id, scorecard.day);
      if (dayStatus.status !== 'open_scoring') return res.status(409).send('Scoring is not open for this day');

      const hole = await getHoleConfig(db, scorecard.event_id, scorecard.day, holeNumber);
      if (!hole) return res.status(400).send('Hole configuration missing');

      let playingHandicap = 0;
      if (scorecard.type === 'individual') {
        const handicap = await db('player_handicaps')
          .where({ event_id: scorecard.event_id, user_id: scorecard.user_id })
          .first();
        playingHandicap = handicap ? Number(handicap.playing_handicap || 0) : 0;
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
        scorecardEventId: scorecard.event_id,
        requesterUserId: req.session.user.id,
        force: canEditAllScores(req.session.user)
      });

      return res.redirect('/scoring');
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
