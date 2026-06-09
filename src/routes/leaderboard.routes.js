'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { buildLeaderboards } = require('../services/leaderboard/leaderboard.service');
const { selectCountingRounds } = require('../services/scoring/stableford-leaderboard.service');
const { calculateEventSkinsForDays } = require('../services/scoring/skins.service');
const { calculateVirtualTeamResults } = require('../services/scoring/virtual-teams.service');
const { calculateTwoBallLeaderboard } = require('../services/scoring/two-ball.service');
const { CALC_TYPES } = require('../config/calc-types');
const { strokesForHole } = require('../services/scoring/handicap.service');
const { getCourseHolesForRound, toScorecardMatrixModel, summarizeTotals, buildIndividualScorecardModel } = require('../services/scoring/scorecard-model.service');
const { ROLES } = require('../config/roles');
const { dayLabel } = require('../services/events/day-label.service');

async function recalculateSkins(db, tour) {
  const rows = await db('scorecards')
    .where({ tour_id: tour.id })
    .groupBy('round_number')
    .select('round_number')
    .count({ total: '*' })
    .sum({ submitted: db.raw(`CASE WHEN status = 'submitted' THEN 1 ELSE 0 END`) });
  const finalizedRoundNumbers = rows
    .filter((r) => Number(r.total) > 0 && Number(r.submitted) === Number(r.total))
    .map((r) => Number(r.round_number));
  await calculateEventSkinsForDays(db, tour.id, finalizedRoundNumbers, {
    initialCarryInSkins: tour.skins_carry_in_skins || 0
  });
}

async function getNoveltyResults(db, tourId, publishedRoundNumbers, tour = null) {
  if (!publishedRoundNumbers.length) return [];
  const events = await db('novelty_events')
    .whereIn('round_number', publishedRoundNumbers)
    .where({ tour_id: tourId })
    .orderBy(['round_number', 'novelty_type', 'hole_number']);
  if (!events.length) return [];

  const results = await db('novelty_results')
    .whereIn('novelty_event_id', events.map((e) => e.id));
  const resultByEventId = new Map(results.map((r) => [r.novelty_event_id, r]));

  const winnerIds = results.map((r) => r.winner_user_id).filter(Boolean);
  const winnerRows = winnerIds.length
    ? await db('users').whereIn('id', winnerIds).select('id', 'first_name', 'last_name')
    : [];
  const winnerById = new Map(winnerRows.map((u) => [u.id, `${u.first_name || ''} ${u.last_name || ''}`.trim()]));

  const prizeByType = tour ? {
    'NTP': Number(tour.prize_ntp_amount || 0) || null,
    'Long Drive': Number(tour.prize_long_drive_amount || 0) || null,
  } : {};

  return events.map((ne) => {
    const result = resultByEventId.get(ne.id) || null;
    const prizeAmount = ne.novelty_type === 'Other'
      ? (Number(ne.prize_amount || 0) || null)
      : (prizeByType[ne.novelty_type] || null);
    return {
      id: ne.id,
      roundNumber: ne.round_number,
      holeNumber: ne.hole_number,
      noveltyType: ne.novelty_type,
      label: ne.label,
      prizeAmount,
      result: result ? {
        isNoWinner: Boolean(result.is_no_winner),
        winnerId: result.winner_user_id || null,
        winnerName: result.winner_user_id ? (winnerById.get(result.winner_user_id) || null) : null,
      } : null,
    };
  });
}

function isPrivileged(req) {
  const role = req.tenantMembership?.role;
  return role === ROLES.ADMIN || role === ROLES.OWNER || role === ROLES.SCORER
    || Boolean(req.res?.locals?.hasTourAdminAccess);
}

function isAdminViewer(req) {
  const role = req.tenantMembership?.role;
  return role === ROLES.ADMIN || role === ROLES.OWNER
    || Boolean(req.res?.locals?.hasTourAdminAccess);
}

function buildPayoutsData(boards, tour, skinsLeaderboard, noveltyResults) {
  const parsePrizes = (v) => Array.isArray(v) ? v : (v ? JSON.parse(v) : []);
  const tourPrizes = parsePrizes(tour.tour_prizes);
  const dailyPrizeList = parsePrizes(tour.daily_prizes);

  const byPlayer = new Map();
  function addPrize(userId, name, prize) {
    if (!byPlayer.has(userId)) byPlayer.set(userId, { userId, name, prizes: [] });
    byPlayer.get(userId).prizes.push(prize);
  }

  // Championship prizes
  const championship = boards?.stableford?.championship || [];
  for (let i = 0; i < Math.min(tourPrizes.length, championship.length); i++) {
    const p = tourPrizes[i];
    const row = championship[i];
    if (Number(p.amount) > 0 && row) {
      addPrize(row.userId, row.name, { label: `Championship — ${p.label}`, amount: Number(p.amount), type: 'championship' });
    }
  }

  // Daily stableford prizes
  const byDay = boards?.stableford?.byDay || {};
  for (const [rnStr, dayBoard] of Object.entries(byDay)) {
    const rn = Number(rnStr);
    for (let i = 0; i < Math.min(dailyPrizeList.length, dayBoard.length); i++) {
      const p = dailyPrizeList[i];
      const row = dayBoard[i];
      if (Number(p.amount) > 0 && row) {
        addPrize(row.userId, row.name, { label: `${dayLabel(rn)} — ${p.label}`, amount: Number(p.amount), type: 'daily' });
      }
    }
  }

  // Skins
  for (const row of (skinsLeaderboard?.playerRows || [])) {
    if (row.payoutAmount > 0) {
      addPrize(row.participantId, row.name, {
        label: `Skins (${row.skinsWon} skin${row.skinsWon !== 1 ? 's' : ''})`,
        amount: row.payoutAmount,
        type: 'skins',
      });
    }
  }

  // Novelty wins
  for (const ne of (noveltyResults || [])) {
    if (!ne.result || ne.result.isNoWinner || !ne.result.winnerId || !ne.prizeAmount) continue;
    addPrize(ne.result.winnerId, ne.result.winnerName, {
      label: ne.label || ne.noveltyType,
      amount: ne.prizeAmount,
      type: 'novelty',
    });
  }

  const players = [...byPlayer.values()]
    .map((p) => ({ ...p, total: p.prizes.reduce((s, x) => s + Number(x.amount || 0), 0) }))
    .filter((p) => p.total > 0)
    .sort((a, b) => b.total - a.total);

  const grandTotal = players.reduce((s, p) => s + p.total, 0);
  return { players, grandTotal };
}

function normalizeLeaderboardView(raw, validDayNumbers, publishedDayNumbers) {
  const candidate = String(raw || '').trim().toLowerCase();
  if (candidate === 'skins') return 'payouts'; // legacy alias
  if (['championship', 'payouts', 'novelty'].includes(candidate)) return candidate;
  const dayMatch = candidate.match(/^day-(\d+)$/);
  if (dayMatch && (validDayNumbers || []).includes(Number(dayMatch[1]))) return candidate;
  // Default: most recent published day (not just visible — admins shouldn't land on an unreleased day by default)
  const defaults = publishedDayNumbers && publishedDayNumbers.length ? publishedDayNumbers : (validDayNumbers || []);
  if (defaults.length) return `day-${defaults[defaults.length - 1]}`;
  return 'championship';
}

function buildDayViews(effectiveVisible, boards, skinsDetail, prizes, roundStates, noveltyResults, virtualTeamResultsByRound, inProgressPlayersByRound, twoBallResultsByRound) {
  return effectiveVisible.map((rn) => {
    const dayBoard = boards.stableford?.byDay?.[rn] || [];
    const skinsForDay = skinsDetail.find((sd) => sd.roundNumber === rn) || null;
    const roundState = roundStates.find((r) => r.roundNumber === rn);

    const wMap = new Map();
    if (skinsForDay) {
      for (const h of skinsForDay.holes) {
        if (h.status !== 'won' || !h.winnerName) continue;
        if (!wMap.has(h.winnerName)) wMap.set(h.winnerName, { name: h.winnerName, skinsWon: 0, dollarWon: 0 });
        wMap.get(h.winnerName).skinsWon += h.skinsAtStake;
        wMap.get(h.winnerName).dollarWon += h.dollarAmount;
      }
    }

    return {
      roundNumber: rn,
      label: dayLabel(rn),
      tourDate: roundState?.tourDate || null,
      isFinalized: roundState?.isFinalized || false,
      twoBallEnabled: roundState?.twoBallEnabled || false,
      twoBallType: roundState?.twoBallType || 'best_ball',
      dayBoard,
      skinsForDay,
      skinsWinners: [...wMap.values()].sort((a, b) => b.skinsWon - a.skinsWon),
      prizes: roundState?.isFinalized ? prizes : [],
      noveltyEvents: (noveltyResults || []).filter((ne) => ne.roundNumber === rn),
      virtualTeamResults: (virtualTeamResultsByRound || {})[rn] || [],
      inProgressPlayers: (inProgressPlayersByRound || {})[rn] || [],
      twoBallResults: (twoBallResultsByRound || {})[rn] || [],
    };
  });
}

function buildChampionshipTable(stablefordBoards, stablefordRoundNumbers) {
  const byDay = stablefordBoards?.byDay || {};
  const championshipRows = Array.isArray(stablefordBoards?.championship) ? stablefordBoards.championship : [];
  const rounds = stablefordRoundNumbers || [];

  const roundMaps = {};
  rounds.forEach((rn) => {
    roundMaps[rn] = new Map((byDay[rn] || []).map((row) => [Number(row.userId), Number(row.total || 0)]));
  });

  const totalCount = new Map();
  championshipRows.forEach((row) => {
    const key = Number(row.total || 0);
    totalCount.set(key, Number(totalCount.get(key) || 0) + 1);
  });

  return championshipRows.map((row) => {
    const userId = Number(row.userId || 0);
    const total = Number(row.total || 0);
    const roundScores = {};
    rounds.forEach((rn) => {
      roundScores[rn] = Number(roundMaps[rn].get(userId) || 0);
    });
    return {
      position: Number(row.position || 0),
      userId,
      name: row.name,
      rounds: roundScores,
      total,
      cb9: Number(row.countbackLast9 || 0),
      cb6: Number(row.countbackLast6 || 0),
      cb3: Number(row.countbackLast3 || 0),
      cb1: Number(row.countbackLast1 || 0),
      countbackUsed: Number(totalCount.get(total) || 0) > 1,
      droppedRounds: row.droppedRounds ? [...row.droppedRounds] : [],
    };
  });
}

function normalizeSkins(holes, visibleRounds) {
  const roundSet = new Set((visibleRounds || []).map(Number));
  const filteredHoles = (holes || []).filter((hole) => roundSet.has(Number(hole.round_number)));
  const byRound = new Map();
  for (const hole of filteredHoles) {
    const rn = Number(hole.round_number);
    if (!byRound.has(rn)) {
      byRound.set(rn, { roundNumber: rn, wins: [], winners: [] });
    }
    if (hole.status !== 'won' || !hole.winning_participant_id || !hole.winner_name) continue;
    const row = byRound.get(rn);
    const basePot = Number(hole.base_pot_amount || 0);
    const totalPot = Number(hole.total_pot_amount || 0);
    const skinsCount = basePot > 0 ? Math.round(totalPot / basePot) : 0;
    row.wins.push({
      roundNumber: rn,
      holeNumber: Number(hole.hole_number),
      name: hole.winner_name,
      participantType: hole.participant_type,
      gross: hole.winning_gross == null ? null : Number(hole.winning_gross),
      stableford: hole.winning_stableford == null ? null : Number(hole.winning_stableford),
      skinsCount
    });
  }

  const daily = [...byRound.values()]
    .sort((a, b) => a.roundNumber - b.roundNumber)
    .map((entry) => {
      const winnerMap = new Map();
      for (const win of entry.wins) {
        const key = `${win.participantType}:${win.name}`;
        if (!winnerMap.has(key)) {
          winnerMap.set(key, { name: win.name, skinsCount: 0 });
        }
        const aggregate = winnerMap.get(key);
        aggregate.skinsCount += Number(win.skinsCount || 0);
      }
      return {
        ...entry,
        wins: entry.wins.sort((a, b) => a.holeNumber - b.holeNumber),
        winners: [...winnerMap.values()].sort((a, b) => (
          Number(b.skinsCount || 0) - Number(a.skinsCount || 0) ||
          String(a.name || '').localeCompare(String(b.name || ''))
        ))
      };
    });

  return { holes: filteredHoles, daily };
}

function buildSkinsLeaderboard(holes, skinPotPerHole) {
  const wins = (holes || [])
    .filter((hole) => String(hole.status || '') === 'won')
    .filter((hole) => Number(hole.winning_participant_id || 0) > 0 && String(hole.winner_name || '').trim().length > 0)
    .map((hole) => {
      const basePot = Number(hole.base_pot_amount || 0);
      const totalPot = Number(hole.total_pot_amount || 0);
      const skinsCount = basePot > 0 ? Math.max(0, Math.round(totalPot / basePot)) : 0;
      return {
        roundNumber: Number(hole.round_number || 0),
        holeNumber: Number(hole.hole_number || 0),
        participantType: String(hole.participant_type || ''),
        participantId: Number(hole.winning_participant_id || 0),
        winnerName: String(hole.winner_name || '').trim(),
        skinsCount
      };
    });

  const aggregate = (participantType) => {
    const map = new Map();
    wins
      .filter((win) => win.participantType === participantType)
      .forEach((win) => {
        const key = `${win.participantType}:${win.participantId}`;
        if (!map.has(key)) {
          map.set(key, {
            participantId: win.participantId,
            name: win.winnerName,
            skinsWon: 0,
            payoutAmount: 0
          });
        }
        const row = map.get(key);
        row.skinsWon += Number(win.skinsCount || 0);
      });
    return [...map.values()]
      .map((row) => ({
        ...row,
        payoutAmount: Number(row.skinsWon || 0) * Number(skinPotPerHole || 0)
      }))
      .sort((a, b) => (
        Number(b.skinsWon || 0) - Number(a.skinsWon || 0) ||
        String(a.name || '').localeCompare(String(b.name || ''))
      ));
  };

  return { playerRows: aggregate('player'), teamRows: aggregate('team') };
}

function buildSkinsDetail(holes, visibleRoundNumbers, stakePerPlayerPerHole) {
  const roundSet = new Set((visibleRoundNumbers || []).map(Number));
  const filtered = (holes || []).filter((h) => roundSet.has(Number(h.round_number)));
  if (!filtered.length) return [];

  const basePot = Number(filtered[0].base_pot_amount || 0);
  const stake = Number(stakePerPlayerPerHole || 0);

  const byRound = new Map();
  for (const hole of filtered) {
    const rn = Number(hole.round_number);
    if (!byRound.has(rn)) byRound.set(rn, []);
    const carryIn = basePot > 0 ? Math.round(Number(hole.carry_in_amount || 0) / basePot) : 0;
    const skinsAtStake = basePot > 0 ? Math.round(Number(hole.total_pot_amount || 0) / basePot) : 1;
    const dollarAmount = hole.status === 'won' && stake > 0
      ? Number(hole.total_pot_amount || 0) * stake
      : 0;
    byRound.get(rn).push({
      holeNumber: Number(hole.hole_number),
      carryIn,
      skinsAtStake,
      dollarAmount,
      status: String(hole.status || 'jackpot'),
      winnerName: hole.winner_name || null,
      tiedCount: Number(hole.tied_count || 0),
      topStableford: Number(hole.top_stableford || 0),
      winningGross: hole.winning_gross != null ? Number(hole.winning_gross) : null,
      winningStableford: hole.winning_stableford != null ? Number(hole.winning_stableford) : null
    });
  }

  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([roundNumber, holeRows]) => ({
      roundNumber,
      holes: holeRows.sort((a, b) => a.holeNumber - b.holeNumber)
    }));
}

function buildChampionshipFromVisibleDays(stablefordByDay, visibleStablefordRounds, bestOf, lastRoundRequired) {
  const byUser = new Map();
  (visibleStablefordRounds || []).forEach((roundNumber) => {
    (stablefordByDay?.[roundNumber] || []).forEach((row) => {
      const key = Number(row.userId);
      if (!byUser.has(key)) byUser.set(key, { userId: key, name: row.name, rounds: [] });
      byUser.get(key).rounds.push({
        roundNumber,
        total: Number(row.total || 0),
        countbackLast9: Number(row.countbackLast9 || 0),
        countbackLast6: Number(row.countbackLast6 || 0),
        countbackLast3: Number(row.countbackLast3 || 0),
        countbackLast1: Number(row.countbackLast1 || 0),
      });
    });
  });

  return [...byUser.values()]
    .map(({ userId, name, rounds }) => {
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
      return entry;
    })
    .sort((a, b) => (
      Number(b.total || 0) - Number(a.total || 0) ||
      Number(b.countbackLast9 || 0) - Number(a.countbackLast9 || 0) ||
      Number(b.countbackLast6 || 0) - Number(a.countbackLast6 || 0) ||
      Number(b.countbackLast3 || 0) - Number(a.countbackLast3 || 0) ||
      Number(b.countbackLast1 || 0) - Number(a.countbackLast1 || 0) ||
      String(a.name || '').localeCompare(String(b.name || ''))
    ))
    .map((row, index) => ({ ...row, position: index + 1 }));
}

async function getPlayerMetaByUserIds(db, tourId, userIds) {
  const ids = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return {};
  const rows = await db('users as u')
    .leftJoin('player_handicaps as ph', function joinHandicap() {
      this.on('ph.user_id', '=', 'u.id').andOnVal('ph.tour_id', '=', tourId);
    })
    .whereIn('u.id', ids)
    .select('u.id', 'u.first_name', 'u.last_name', 'ph.playing_handicap');

  const meta = {};
  rows.forEach((row) => {
    const userId = Number(row.id);
    meta[userId] = {
      userId,
      name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
      handicap: row.playing_handicap == null ? null : Math.trunc(Number(row.playing_handicap))
    };
  });
  return meta;
}

async function getAmbroseTeamMembersByTeamId(db, tourId, teamIds) {
  const ids = [...new Set((teamIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return {};

  const rows = await db('team_members as tm')
    .join('users as u', 'u.id', 'tm.user_id')
    .leftJoin('player_handicaps as ph', function joinHcp() {
      this.on('ph.user_id', '=', 'u.id').andOnVal('ph.tour_id', '=', tourId);
    })
    .whereIn('tm.team_id', ids)
    .orderBy([{ column: 'tm.team_id', order: 'asc' }, { column: 'u.last_name', order: 'asc' }, { column: 'u.first_name', order: 'asc' }])
    .select(
      'tm.team_id',
      'tm.is_dual_assigned',
      'u.id',
      'u.first_name',
      'u.last_name',
      'ph.playing_handicap'
    );

  const out = {};
  rows.forEach((row) => {
    const teamId = Number(row.team_id);
    if (!out[teamId]) out[teamId] = [];
    out[teamId].push({
      id: Number(row.id),
      first_name: row.first_name,
      last_name: row.last_name,
      handicap_display: formatHandicapDisplay(row.playing_handicap),
      is_dual_assigned: Number(row.is_dual_assigned || 0) === 1
    });
  });
  return out;
}

function formatHandicapDisplay(raw) {
  if (raw === null || raw === undefined || raw === '') return '-';
  const num = Number(raw);
  if (!Number.isFinite(num)) return '-';
  const abs = Number.isInteger(num) ? String(Math.abs(num)) : String(Math.abs(num).toFixed(1)).replace(/\.0$/, '');
  return num < 0 ? `+${abs}` : abs;
}

async function getRoundPublicationRows(db, tourId) {
  const rows = await db('golf_rounds')
    .where({ tour_id: tourId })
    .select('round_number', 'status', 'leaderboard_published', 'leaderboard_show_in_progress', 'calc_type', 'virtual_teams_enabled', 'two_ball_enabled', 'two_ball_type')
    .orderBy('round_number');
  return rows.map((r) => ({
    roundNumber: Number(r.round_number),
    status: r.status || 'draft',
    calcType: r.calc_type || 'stableford',
    leaderboardPublished: Number(r.leaderboard_published || 0) === 1,
    showInProgress: Boolean(r.leaderboard_show_in_progress),
    virtualTeamsEnabled: Boolean(r.virtual_teams_enabled),
    twoBallEnabled: Boolean(r.two_ball_enabled),
    twoBallType: r.two_ball_type || 'best_ball',
  }));
}

async function getRoundFinalizationRows(db, tourId) {
  const rows = await db('scorecards')
    .where({ tour_id: tourId })
    .groupBy('round_number')
    .select('round_number')
    .count({ total: '*' })
    .sum({
      submitted: db.raw(`CASE WHEN status = 'submitted' THEN 1 ELSE 0 END`)
    });
  return rows.map((r) => ({
    roundNumber: Number(r.round_number),
    total: Number(r.total || 0),
    submitted: Number(r.submitted || 0),
    isFinalized: Number(r.total || 0) > 0 && Number(r.submitted || 0) === Number(r.total || 0)
  }));
}

async function getPublishedRoundSet(db, tourId) {
  const rows = await getRoundPublicationRows(db, tourId);
  return new Set(rows.filter((r) => r.leaderboardPublished).map((r) => Number(r.roundNumber)));
}

function ambroseAllowance(memberCount) {
  if (Number(memberCount) === 2) return 1 / 4;
  if (Number(memberCount) === 3) return 1 / 3;
  return 0;
}

async function buildAmbroseScorecardModel(db, tour, teamId) {
  const scorecard = await db('scorecards as s')
    .join('teams as t', 't.id', 's.team_id')
    .where({ 's.tour_id': tour.id, 's.type': 'team', 't.id': teamId })
    .select('s.id', 's.round_number', 's.team_id', 't.name as team_name')
    .first();
  if (!scorecard) return null;

  const roundNumber = Number(scorecard.round_number);
  const [holeConfig, holeScores, memberRows, roundRow] = await Promise.all([
    getCourseHolesForRound(db, tour.id, roundNumber),
    db('scorecard_holes')
      .where({ scorecard_id: scorecard.id })
      .select('hole_number', 'gross_score', 'stableford_points'),
    db('team_members as tm')
      .join('users as u', 'u.id', 'tm.user_id')
      .leftJoin('player_handicaps as ph', function joinPh() {
        this.on('ph.user_id', '=', 'tm.user_id').andOnVal('ph.tour_id', '=', tour.id);
      })
      .where({ 'tm.team_id': teamId })
      .select('u.first_name', 'u.last_name', 'ph.playing_handicap'),
    db('golf_rounds').where({ tour_id: tour.id, round_number: roundNumber }).first()
  ]);
  if (!holeConfig.length) return null;

  const memberHandicaps = memberRows.map((r) => Number(r.playing_handicap || 0));
  const allowance = ambroseAllowance(memberRows.length);
  const exactTeamHandicap = memberHandicaps.reduce((sum, v) => sum + Number(v || 0), 0) * allowance;
  const wholeTeamHandicap = Math.trunc(exactTeamHandicap);

  const byHole = new Map(holeScores.map((row) => [Number(row.hole_number), row]));
  const holes = holeConfig.map((hole) => {
    const saved = byHole.get(Number(hole.hole_number));
    const gross = saved ? Number(saved.gross_score) : null;
    const shots = strokesForHole(wholeTeamHandicap, Number(hole.stroke_index_primary), Number(hole.stroke_index_secondary));
    return {
      holeNumber: Number(hole.hole_number),
      par: Number(hole.par || 0),
      siPrimary: Number(hole.stroke_index_primary || 0),
      siSecondary: Number(hole.stroke_index_secondary || 0),
      gross,
      net: gross == null ? null : gross - shots,
      stableford: saved && saved.stableford_points != null ? Number(saved.stableford_points) : null
    };
  });

  const calcType = String(roundRow?.calc_type || 'ambrose_nett');
  const totals = summarizeTotals(holes);
  const netExact = totals.grossTotal - exactTeamHandicap;
  const membersLabel = memberRows
    .map((m) => `${m.first_name || ''} ${m.last_name || ''}`.trim())
    .filter(Boolean)
    .join(', ');

  return toScorecardMatrixModel({
    mode: 'team',
    roundNumber,
    roundLabel: dayLabel(roundNumber),
    dayLabel: dayLabel(roundNumber),
    calcType,
    showStablefordTotals: false,
    showGrossOnlyTotals: true,
    title: scorecard.team_name || 'Team',
    subtitle: membersLabel || null,
    resultLabel: `${totals.grossTotal} gross / ${netExact.toFixed(2).replace(/\.00$/, '')} net`,
    totals,
    holes
  });
}

async function buildEclecticScorecardModel(db, tour, userId, roundNumbers = []) {
  const scopedRounds = (Array.isArray(roundNumbers) ? roundNumbers : [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!scopedRounds.length) return null;

  const [user, handicap] = await Promise.all([
    db('users').where({ id: userId }).first(),
    db('player_handicaps').where({ tour_id: tour.id, user_id: userId }).first()
  ]);
  if (!user) return null;

  const configRound = [...scopedRounds].sort((a, b) => a - b)[0];
  const holeConfig = await getCourseHolesForRound(db, tour.id, configRound);
  if (!holeConfig.length) return null;

  const rows = await db('scorecards as s')
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .where({ 's.tour_id': tour.id, 's.type': 'individual', 's.user_id': userId })
    .whereIn('s.round_number', scopedRounds)
    .select('s.round_number', 'sh.hole_number', 'sh.gross_score', 'sh.stableford_points');

  const bestByHole = new Map();
  for (const row of rows) {
    const hole = Number(row.hole_number);
    const stableford = Number(row.stableford_points || 0);
    const gross = Number(row.gross_score || 0);
    const roundNumber = Number(row.round_number || 0);
    if (!bestByHole.has(hole)) {
      bestByHole.set(hole, { hole, stableford, gross, roundNumber });
      continue;
    }
    const current = bestByHole.get(hole);
    if (
      stableford > Number(current.stableford || 0) ||
      (stableford === Number(current.stableford || 0) && gross < Number(current.gross || 0)) ||
      (stableford === Number(current.stableford || 0) && gross === Number(current.gross || 0) && roundNumber < Number(current.roundNumber || 0))
    ) {
      bestByHole.set(hole, { hole, stableford, gross, roundNumber });
    }
  }

  const hcp = Math.trunc(Number(handicap?.playing_handicap || 0));
  const holes = holeConfig.map((hole) => {
    const best = bestByHole.get(Number(hole.hole_number));
    const gross = best ? Number(best.gross) : null;
    const stableford = best ? Number(best.stableford) : 0;
    const shots = strokesForHole(
      hcp,
      Number(hole.stroke_index_primary || 0),
      Number(hole.stroke_index_secondary || 0)
    );
    return {
      holeNumber: Number(hole.hole_number),
      par: Number(hole.par || 0),
      siPrimary: Number(hole.stroke_index_primary || 0),
      siSecondary: Number(hole.stroke_index_secondary || 0),
      gross,
      net: gross == null ? null : gross - shots,
      stableford
    };
  });

  const totalPoints = holes.reduce((sum, h) => sum + Number(h.stableford || 0), 0);
  return toScorecardMatrixModel({
    mode: 'individual',
    roundNumber: configRound,
    roundLabel: 'Eclectic',
    dayLabel: 'All Rounds',
    calcType: CALC_TYPES.STABLEFORD,
    showStablefordTotals: true,
    showGrossOnlyTotals: false,
    title: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
    subtitle: `Hcp ${hcp}`,
    resultLabel: `${totalPoints} pts`,
    totals: summarizeTotals(holes),
    holes
  });
}

function buildRoundStates(publicationRows, finalizationRows) {
  const finByRound = new Map(finalizationRows.map((r) => [r.roundNumber, r]));
  return publicationRows.map((pub) => {
    const fin = finByRound.get(pub.roundNumber) || { total: 0, submitted: 0, isFinalized: false };
    return {
      roundNumber: pub.roundNumber,
      label: dayLabel(pub.roundNumber),
      status: pub.status,
      calcType: pub.calcType,
      leaderboardPublished: pub.leaderboardPublished,
      showInProgress: pub.showInProgress || false,
      virtualTeamsEnabled: pub.virtualTeamsEnabled || false,
      twoBallEnabled: pub.twoBallEnabled || false,
      twoBallType: pub.twoBallType || 'best_ball',
      total: fin.total,
      submitted: fin.submitted,
      isFinalized: fin.isFinalized
    };
  });
}

function deriveRoundSets(roundStates) {
  const finalizedRoundNumbers = roundStates.filter((r) => r.isFinalized).map((r) => r.roundNumber);
  const publishedRoundNumbers = roundStates.filter((r) => r.leaderboardPublished).map((r) => r.roundNumber);
  const stablefordRoundNumbers = roundStates.filter((r) => r.calcType !== 'ambrose_nett').map((r) => r.roundNumber);
  const visibleStablefordRounds = publishedRoundNumbers.filter((rn) => stablefordRoundNumbers.includes(rn));
  const inProgressRoundNumbers = roundStates
    .filter((r) => r.leaderboardPublished && r.showInProgress && !r.isFinalized)
    .map((r) => r.roundNumber);
  return { finalizedRoundNumbers, publishedRoundNumbers, stablefordRoundNumbers, visibleStablefordRounds, inProgressRoundNumbers };
}

function buildVisibleBoards(boards, roundStates, publishedRoundNumbers, stablefordRoundNumbers, skinsNormalized, championship) {
  const stablefordByDayVisible = {};
  stablefordRoundNumbers.forEach((rn) => {
    stablefordByDayVisible[rn] = publishedRoundNumbers.includes(rn) ? (boards.stableford?.byDay?.[rn] || []) : [];
  });
  return {
    stableford: { byDay: stablefordByDayVisible, championship },
    skins: {
      ...boards.skins,
      holes: skinsNormalized.holes,
      daily: skinsNormalized.daily
    }
  };
}

function leaderboardRouter(db) {
  const router = express.Router();

  router.post('/publish/:roundNumber', requireAuth, async (req, res, next) => {
    try {
      const roundNumber = Number(req.params.roundNumber);
      const tp = res.locals.tenantPath;
      if (!Number.isInteger(roundNumber) || roundNumber <= 0) {
        return res.redirect(tp('/leaderboards?error=Invalid%20round'));
      }
      if (!isPrivileged(req)) return res.status(403).send('Forbidden');

      const active = await db('tours').where({ tenant_id: req.tenant.id, status: 'active' }).first();
      if (!active) return res.redirect(tp('/leaderboards?error=No%20active%20tour'));

      const finRow = await db('scorecards')
        .where({ tour_id: active.id, round_number: roundNumber })
        .count({ total: '*' })
        .sum({ submitted: db.raw(`CASE WHEN status = 'submitted' THEN 1 ELSE 0 END`) })
        .first();
      const total = Number(finRow?.total || 0);
      const submitted = Number(finRow?.submitted || 0);
      if (total === 0 || submitted !== total) {
        return res.redirect(tp(`/leaderboards?error=${encodeURIComponent(`${dayLabel(roundNumber)} is not finalized`)}`));
      }

      const existing = await db('golf_rounds').where({ tour_id: active.id, round_number: roundNumber }).first();
      if (!existing) return res.redirect(tp('/leaderboards?error=Round%20not%20configured'));

      await db('golf_rounds')
        .where({ id: existing.id })
        .update({ leaderboard_published: 1, updated_at: db.fn.now() });

      await recalculateSkins(db, active);

      return res.redirect(tp(`/leaderboards?message=${encodeURIComponent(`${dayLabel(roundNumber)} published`)}`));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/unpublish/:roundNumber', requireAuth, async (req, res, next) => {
    try {
      const roundNumber = Number(req.params.roundNumber);
      const tp = res.locals.tenantPath;
      if (!Number.isInteger(roundNumber) || roundNumber <= 0) {
        return res.redirect(tp('/leaderboards?error=Invalid%20round'));
      }
      if (!isPrivileged(req)) return res.status(403).send('Forbidden');

      const active = await db('tours').where({ tenant_id: req.tenant.id, status: 'active' }).first();
      if (!active) return res.redirect(tp('/leaderboards?error=No%20active%20tour'));

      const existing = await db('golf_rounds').where({ tour_id: active.id, round_number: roundNumber }).first();
      if (!existing) return res.redirect(tp('/leaderboards?error=Round%20not%20configured'));

      await db('golf_rounds')
        .where({ id: existing.id })
        .update({ leaderboard_published: 0, updated_at: db.fn.now() });

      await recalculateSkins(db, active);

      return res.redirect(tp(`/leaderboards?message=${encodeURIComponent(`${dayLabel(roundNumber)} unpublished`)}`));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/tour/:tourId/scorecards/individual/:userId', requireAuth, async (req, res, next) => {
    try {
      const tourId = Number(req.params.tourId);
      const userId = Number(req.params.userId);
      const roundNumber = Number(req.query.round || req.query.day);
      const tp = res.locals.tenantPath;
      if (!Number.isInteger(tourId) || tourId <= 0) return res.redirect(tp('/leaderboards?error=Invalid%20tour'));
      if (!Number.isInteger(userId) || userId <= 0) return res.redirect(tp(`/leaderboards/tour/${tourId}?error=Invalid%20player`));
      if (!Number.isInteger(roundNumber) || roundNumber <= 0) return res.redirect(tp(`/leaderboards/tour/${tourId}?error=Invalid%20round`));

      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.redirect(tp('/leaderboards?error=Tour%20not%20found'));
      const publishedRounds = await getPublishedRoundSet(db, tourId);
      if (!publishedRounds.has(roundNumber)) return res.redirect(tp(`/leaderboards/tour/${tourId}?error=Round%20not%20published`));

      const [scorecardModel, roundRow] = await Promise.all([
        buildIndividualScorecardModel(db, tour, roundNumber, userId),
        db('golf_rounds as gr').leftJoin('courses as c', 'c.id', 'gr.course_id')
          .where({ 'gr.tour_id': tourId, 'gr.round_number': roundNumber })
          .select('gr.tour_date', 'c.course_name').first(),
      ]);
      if (!scorecardModel) return res.redirect(tp(`/leaderboards/tour/${tourId}?error=Scorecard%20not%20found`));
      if (roundRow) { scorecardModel.courseName = roundRow.course_name; scorecardModel.tourDate = roundRow.tour_date; }

      return res.render('leaderboard/scorecard-view', {
        title: `${scorecardModel.title} ${dayLabel(roundNumber)} Scorecard`,
        user: req.session.user,
        activeTour: tour,
        models: [scorecardModel],
        backUrl: tp(`/leaderboards/tour/${tourId}?view=championship`),
        backLabel: 'Back to Leaderboard',
        pageSubtitle: `${tour.year} · ${tour.location}`
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/tour/:tourId/scorecards/team/:teamId', requireAuth, async (req, res, next) => {
    try {
      const tourId = Number(req.params.tourId);
      const teamId = Number(req.params.teamId);
      const tp = res.locals.tenantPath;
      if (!Number.isInteger(tourId) || tourId <= 0) return res.redirect(tp('/leaderboards?error=Invalid%20tour'));
      if (!Number.isInteger(teamId) || teamId <= 0) return res.redirect(tp(`/leaderboards/tour/${tourId}?error=Invalid%20team`));

      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.redirect(tp('/leaderboards?error=Tour%20not%20found'));

      const scorecardModel = await buildAmbroseScorecardModel(db, tour, teamId);
      if (!scorecardModel) return res.redirect(tp(`/leaderboards/tour/${tourId}?error=Scorecard%20not%20found`));

      const [publishedRounds, roundRow] = await Promise.all([
        getPublishedRoundSet(db, tourId),
        db('golf_rounds as gr').leftJoin('courses as c', 'c.id', 'gr.course_id')
          .where({ 'gr.tour_id': tourId, 'gr.round_number': scorecardModel.roundNumber })
          .select('gr.tour_date', 'c.course_name').first(),
      ]);
      if (!publishedRounds.has(Number(scorecardModel.roundNumber))) {
        return res.redirect(tp(`/leaderboards/tour/${tourId}?error=Ambrose%20not%20published`));
      }
      if (roundRow) { scorecardModel.courseName = roundRow.course_name; scorecardModel.tourDate = roundRow.tour_date; }

      return res.render('leaderboard/scorecard-view', {
        title: `${scorecardModel.title} ${scorecardModel.dayLabel} Scorecard`,
        user: req.session.user,
        activeTour: tour,
        models: [scorecardModel],
        backUrl: tp(`/leaderboards/tour/${tourId}?view=ambrose`),
        backLabel: 'Back to Leaderboard',
        pageSubtitle: `${tour.year} · ${tour.location}`
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/tour/:tourId/scorecards/championship/:userId', requireAuth, async (req, res, next) => {
    try {
      const tourId = Number(req.params.tourId);
      const userId = Number(req.params.userId);
      const tp = res.locals.tenantPath;
      if (!Number.isInteger(tourId) || tourId <= 0) return res.redirect(tp('/leaderboards?error=Invalid%20tour'));
      if (!Number.isInteger(userId) || userId <= 0) return res.redirect(tp(`/leaderboards/tour/${tourId}?error=Invalid%20player`));

      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.redirect(tp('/leaderboards?error=Tour%20not%20found'));

      const pubRows = await getRoundPublicationRows(db, tourId);
      const publishedStablefordRounds = pubRows
        .filter((r) => r.leaderboardPublished && r.calcType !== 'ambrose_nett')
        .map((r) => r.roundNumber);
      if (!publishedStablefordRounds.length) {
        return res.redirect(tp(`/leaderboards/tour/${tourId}?error=No%20published%20rounds`));
      }

      const [modelsRaw, roundMetaRows] = await Promise.all([
        Promise.all(publishedStablefordRounds.map((rn) => buildIndividualScorecardModel(db, tour, rn, userId))),
        db('golf_rounds as gr')
          .leftJoin('courses as c', 'c.id', 'gr.course_id')
          .where({ 'gr.tour_id': tourId })
          .whereIn('gr.round_number', publishedStablefordRounds)
          .select('gr.round_number', 'gr.tour_date', 'c.course_name'),
      ]);
      const roundMeta = {};
      for (const r of roundMetaRows) {
        roundMeta[r.round_number] = { courseName: r.course_name, tourDate: r.tour_date };
      }

      const models = modelsRaw.filter(Boolean).map((m) => {
        const meta = roundMeta[m.roundNumber] || {};
        return { ...m, courseName: meta.courseName || null, tourDate: meta.tourDate || null };
      });
      if (!models.length) return res.redirect(tp(`/leaderboards/tour/${tourId}?error=No%20scorecards%20found`));

      const playerName = models[0].title;
      return res.render('leaderboard/scorecard-view', {
        title: `${playerName} Championship Cards`,
        user: req.session.user,
        activeTour: tour,
        models,
        backUrl: tp(`/leaderboards/tour/${tourId}?view=championship`),
        backLabel: 'Back to Championship',
        pageSubtitle: `${tour.year} · ${tour.location} · Championship`
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/tour/:tourId/scorecards/eclectic/:userId', requireAuth, async (req, res, next) => {
    try {
      const tourId = Number(req.params.tourId);
      const userId = Number(req.params.userId);
      const tp = res.locals.tenantPath;
      if (!Number.isInteger(tourId) || tourId <= 0) return res.redirect(tp('/leaderboards?error=Invalid%20tour'));
      if (!Number.isInteger(userId) || userId <= 0) return res.redirect(tp(`/leaderboards/tour/${tourId}?error=Invalid%20player`));

      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.redirect(tp('/leaderboards?error=Tour%20not%20found'));

      const pubRows = await getRoundPublicationRows(db, tourId);
      const publishedStablefordRounds = pubRows
        .filter((r) => r.leaderboardPublished && r.calcType !== 'ambrose_nett')
        .map((r) => r.roundNumber);
      if (publishedStablefordRounds.length < 2) {
        return res.redirect(tp(`/leaderboards/tour/${tourId}?view=eclectic&error=Eclectic%20is%20available%20after%20Round%202`));
      }

      const scorecardModel = await buildEclecticScorecardModel(db, tour, userId, publishedStablefordRounds);
      if (!scorecardModel) {
        return res.redirect(tp(`/leaderboards/tour/${tourId}?view=eclectic&error=Eclectic%20scorecard%20not%20found`));
      }

      return res.render('leaderboard/scorecard-view', {
        title: `${scorecardModel.title} Eclectic Scorecard`,
        user: req.session.user,
        activeTour: tour,
        models: [scorecardModel],
        backUrl: tp(`/leaderboards/tour/${tourId}?view=eclectic`),
        backLabel: 'Back to Eclectic',
        pageSubtitle: `${tour.year} · ${tour.location} · Eclectic`
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/tour/:tourId', requireAuth, async (req, res, next) => {
    try {
      const viewer = req.session.user;
      const tourId = Number(req.params.tourId);
      const tp = res.locals.tenantPath;
      if (!Number.isInteger(tourId) || tourId <= 0) {
        return res.redirect(tp('/admin/dashboard?error=Invalid%20tour'));
      }

      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) {
        return res.redirect(tp('/admin/dashboard?error=Tour%20not%20found'));
      }

      const [publicationRows, finalizationRows] = await Promise.all([
        getRoundPublicationRows(db, tour.id),
        getRoundFinalizationRows(db, tour.id),
      ]);

      const roundStates = buildRoundStates(publicationRows, finalizationRows);
      const { finalizedRoundNumbers, publishedRoundNumbers, stablefordRoundNumbers, visibleStablefordRounds, inProgressRoundNumbers } = deriveRoundSets(roundStates);

      const adminView = isAdminViewer(req);
      const effectivePublished = adminView ? stablefordRoundNumbers : publishedRoundNumbers;
      const effectiveVisible = adminView ? stablefordRoundNumbers : visibleStablefordRounds;
      const showAggregate = effectiveVisible.length > 0;
      const activeView = normalizeLeaderboardView(req.query.view, effectiveVisible, visibleStablefordRounds);

      const boards = await buildLeaderboards(db, tour.id, {
        finalizedRoundsForSkins: finalizedRoundNumbers,
        roundNumbers: stablefordRoundNumbers,
        bestOf: tour.leaderboard_best_of_rounds || null,
        lastRoundRequired: tour.leaderboard_last_round_required || false,
        initialCarryInSkins: tour.skins_carry_in_skins || 0,
        leaderboardDirtyAt: tour.leaderboard_dirty_at || null,
      });

      const championship = showAggregate
        ? buildChampionshipFromVisibleDays(boards.stableford?.byDay || {}, effectiveVisible, tour.leaderboard_best_of_rounds || null, tour.leaderboard_last_round_required || false)
        : [];
      const skinsNormalized = normalizeSkins(boards.skins.holes, effectivePublished);
      const visibleBoards = buildVisibleBoards(
        boards, roundStates, effectivePublished, stablefordRoundNumbers, skinsNormalized, championship
      );

      const skinsDetail = buildSkinsDetail(visibleBoards.skins.holes, effectivePublished, tour.skins_amount_per_player_per_hole);
      const championshipTable = buildChampionshipTable(visibleBoards.stableford, stablefordRoundNumbers);

      const playerMetaById = await getPlayerMetaByUserIds(db, tour.id, championshipTable.map((row) => Number(row.userId)));
      const noveltyResults = await getNoveltyResults(db, tour.id, effectivePublished, tour);

      const dailyPrizes = Array.isArray(tour.daily_prizes)
        ? tour.daily_prizes
        : (tour.daily_prizes ? JSON.parse(tour.daily_prizes) : []);

      const skinsPotPerHole = Number(boards.skins.activePlayerCount || 0) * Number(tour.skins_amount_per_player_per_hole || 0);
      const skinsLeaderboard = buildSkinsLeaderboard(visibleBoards.skins.holes, skinsPotPerHole);
      const payoutsData = buildPayoutsData(visibleBoards, tour, skinsLeaderboard, noveltyResults);

      const vtEnabledRounds = roundStates.filter((r) => r.virtualTeamsEnabled && effectiveVisible.includes(r.roundNumber));
      const virtualTeamResultsByRound = {};
      for (const r of vtEnabledRounds) {
        virtualTeamResultsByRound[r.roundNumber] = await calculateVirtualTeamResults(db, tour.id, r.roundNumber);
      }

      const inProgressPlayersByRound = {};
      for (const rn of inProgressRoundNumbers) {
        const rows = await db('scorecards as s')
          .join('users as u', 'u.id', 's.user_id')
          .where({ 's.tour_id': tour.id, 's.round_number': rn, 's.type': 'individual' })
          .whereNot('s.status', 'submitted')
          .select('s.user_id', 'u.first_name', 'u.last_name');
        inProgressPlayersByRound[rn] = rows.map((r) => ({
          userId: Number(r.user_id),
          name: `${r.first_name || ''} ${r.last_name || ''}`.trim()
        }));
      }

      const twoBallResultsByRound = {};
      const twoBallRounds = roundStates.filter((r) => r.twoBallEnabled && r.isFinalized && effectiveVisible.includes(r.roundNumber));
      for (const r of twoBallRounds) {
        twoBallResultsByRound[r.roundNumber] = await calculateTwoBallLeaderboard(db, tour.id, r.roundNumber, r.twoBallType);
      }

      const dayViews = buildDayViews(effectiveVisible, boards, skinsDetail, dailyPrizes, roundStates, noveltyResults, virtualTeamResultsByRound, inProgressPlayersByRound, twoBallResultsByRound);

      return res.render('leaderboard/index', {
        title: `Leaderboards ${tour.year}`,
        user: viewer,
        activeTour: tour,
        boards: visibleBoards,
        skinsDetail,
        skinsLeaderboard,
        payoutsData,
        championshipTable,
        playerMetaById,
        noveltyResults,
        roundStates,
        stablefordRoundNumbers,
        activeView,
        dayViews,
        leaderboardBasePath: tp(`/leaderboards/tour/${tour.id}`),
        canManagePublish: adminView,
        hasDirtyMarker: false,
        dayLabel,
        dailyPrizes,
        message: req.query.message ? String(req.query.message) : null,
        error: req.query.error ? String(req.query.error) : null
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/', requireAuth, async (req, res, next) => {
    try {
      const viewer = req.session.user;
      const tp = res.locals.tenantPath;
      const active = await db('tours').where({ tenant_id: req.tenant.id, status: 'active' }).first();

      if (!active) {
        const activeView = normalizeLeaderboardView(req.query.view);
        return res.render('leaderboard/index', {
          title: 'Leaderboards',
          user: viewer,
          activeTour: null,
          boards: {
            stableford: { byDay: {}, championship: [] },
            skins: { holes: [], winners: [], activePlayerCount: 0, stakePerPlayer: 1 }
          },
          skinsDetail: [],
          skinsLeaderboard: { playerRows: [], teamRows: [] },
          payoutsData: { players: [], grandTotal: 0 },
          championshipTable: [],
          playerMetaById: {},
          noveltyResults: [],
          roundStates: [],
          stablefordRoundNumbers: [],
          activeView,
          dayViews: [],
          leaderboardBasePath: tp('/leaderboards'),
          canManagePublish: false,
          hasDirtyMarker: false,
          dayLabel,
          message: req.query.message ? String(req.query.message) : null,
          error: req.query.error ? String(req.query.error) : null
        });
      }

      const [publicationRows, finalizationRows] = await Promise.all([
        getRoundPublicationRows(db, active.id),
        getRoundFinalizationRows(db, active.id),
      ]);

      const roundStates = buildRoundStates(publicationRows, finalizationRows);
      const { finalizedRoundNumbers, publishedRoundNumbers, stablefordRoundNumbers, visibleStablefordRounds, inProgressRoundNumbers } = deriveRoundSets(roundStates);

      const adminView = isAdminViewer(req);
      const effectivePublished = adminView ? stablefordRoundNumbers : publishedRoundNumbers;
      const effectiveVisible = adminView ? stablefordRoundNumbers : visibleStablefordRounds;
      const showAggregate = effectiveVisible.length > 0;
      const activeView = normalizeLeaderboardView(req.query.view, effectiveVisible, visibleStablefordRounds);

      const boards = await buildLeaderboards(db, active.id, {
        finalizedRoundsForSkins: finalizedRoundNumbers,
        roundNumbers: stablefordRoundNumbers,
        bestOf: active.leaderboard_best_of_rounds || null,
        lastRoundRequired: active.leaderboard_last_round_required || false,
        initialCarryInSkins: active.skins_carry_in_skins || 0,
        leaderboardDirtyAt: active.leaderboard_dirty_at || null,
      });

      const championship = showAggregate
        ? buildChampionshipFromVisibleDays(boards.stableford?.byDay || {}, effectiveVisible, active.leaderboard_best_of_rounds || null, active.leaderboard_last_round_required || false)
        : [];
      const skinsNormalized = normalizeSkins(boards.skins.holes, effectivePublished);
      const visibleBoards = buildVisibleBoards(
        boards, roundStates, effectivePublished, stablefordRoundNumbers, skinsNormalized, championship
      );

      const skinsDetail = buildSkinsDetail(visibleBoards.skins.holes, effectivePublished, active.skins_amount_per_player_per_hole);
      const championshipTable = buildChampionshipTable(visibleBoards.stableford, stablefordRoundNumbers);

      const playerMetaById = await getPlayerMetaByUserIds(db, active.id, championshipTable.map((row) => Number(row.userId)));
      const noveltyResults = await getNoveltyResults(db, active.id, effectivePublished, active);

      const dailyPrizes = Array.isArray(active.daily_prizes)
        ? active.daily_prizes
        : (active.daily_prizes ? JSON.parse(active.daily_prizes) : []);

      const skinsPotPerHole = Number(boards.skins.activePlayerCount || 0) * Number(active.skins_amount_per_player_per_hole || 0);
      const skinsLeaderboard = buildSkinsLeaderboard(visibleBoards.skins.holes, skinsPotPerHole);
      const payoutsData = buildPayoutsData(visibleBoards, active, skinsLeaderboard, noveltyResults);

      const vtEnabledRounds = roundStates.filter((r) => r.virtualTeamsEnabled && effectiveVisible.includes(r.roundNumber));
      const virtualTeamResultsByRound = {};
      for (const r of vtEnabledRounds) {
        virtualTeamResultsByRound[r.roundNumber] = await calculateVirtualTeamResults(db, active.id, r.roundNumber);
      }

      const inProgressPlayersByRound = {};
      for (const rn of inProgressRoundNumbers) {
        const rows = await db('scorecards as s')
          .join('users as u', 'u.id', 's.user_id')
          .where({ 's.tour_id': active.id, 's.round_number': rn, 's.type': 'individual' })
          .whereNot('s.status', 'submitted')
          .select('s.user_id', 'u.first_name', 'u.last_name');
        inProgressPlayersByRound[rn] = rows.map((r) => ({
          userId: Number(r.user_id),
          name: `${r.first_name || ''} ${r.last_name || ''}`.trim()
        }));
      }

      const twoBallResultsByRound = {};
      const twoBallRounds = roundStates.filter((r) => r.twoBallEnabled && r.isFinalized && effectiveVisible.includes(r.roundNumber));
      for (const r of twoBallRounds) {
        twoBallResultsByRound[r.roundNumber] = await calculateTwoBallLeaderboard(db, active.id, r.roundNumber, r.twoBallType);
      }

      const dayViews = buildDayViews(effectiveVisible, boards, skinsDetail, dailyPrizes, roundStates, noveltyResults, virtualTeamResultsByRound, inProgressPlayersByRound, twoBallResultsByRound);

      return res.render('leaderboard/index', {
        title: 'Leaderboards',
        user: viewer,
        activeTour: active,
        boards: visibleBoards,
        skinsDetail,
        skinsLeaderboard,
        payoutsData,
        championshipTable,
        playerMetaById,
        noveltyResults,
        roundStates,
        stablefordRoundNumbers,
        activeView,
        dayViews,
        leaderboardBasePath: tp('/leaderboards'),
        canManagePublish: adminView,
        hasDirtyMarker: false,
        dayLabel,
        dailyPrizes,
        message: req.query.message ? String(req.query.message) : null,
        error: req.query.error ? String(req.query.error) : null
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { leaderboardRouter };
