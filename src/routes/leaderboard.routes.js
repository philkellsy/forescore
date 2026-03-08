'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { buildLeaderboards } = require('../services/leaderboard/leaderboard.service');
const { calculateEclecticLeaderboard } = require('../services/scoring/eclectic.service');
const { calculateSultansLeaderboard } = require('../services/scoring/sultans.service');
const { CALC_TYPES, defaultCalcTypeForDay } = require('../config/calc-types');
const { strokesForHole } = require('../services/scoring/handicap.service');
const { ROLES } = require('../config/roles');
const { dayLabel } = require('../services/events/day-label.service');

function isPrivileged(user) {
  return user && (user.role === ROLES.ADMIN || user.role === ROLES.SCORER);
}

function normalizeLeaderboardView(raw) {
  const allowed = new Set(['championship', 'ambrose', 'eclectic', 'sultans', 'skins', 'calcutta']);
  const candidate = String(raw || '').trim().toLowerCase();
  return allowed.has(candidate) ? candidate : 'championship';
}

async function getCalcuttaSummary(db, eventId, viewerUserId) {
  const activePlayers = await db('event_players as ep')
    .join('users as u', 'u.id', 'ep.user_id')
    .where({ 'ep.event_id': eventId, 'ep.status': 'active' })
    .orderBy([{ column: 'u.last_name', order: 'asc' }, { column: 'u.first_name', order: 'asc' }])
    .select('u.id', 'u.first_name', 'u.last_name');

  const participantsById = new Map(
    activePlayers.map((p) => [Number(p.id), { userId: Number(p.id), name: `${p.first_name || ''} ${p.last_name || ''}`.trim() }])
  );

  const sales = await db('calcutta_auctions as ca')
    .join('users as auctioned', 'auctioned.id', 'ca.auctioned_user_id')
    .join('users as buyer', 'buyer.id', 'ca.buyer_user_id')
    .leftJoin('users as owner', 'owner.id', 'ca.owner_user_id')
    .where({ 'ca.event_id': eventId })
    .orderBy('ca.draw_order', 'asc')
    .select(
      'ca.id',
      'ca.draw_order',
      'ca.auctioned_user_id',
      'ca.buyer_user_id',
      'ca.owner_user_id',
      'ca.auction_bid_amount',
      'auctioned.first_name as auctioned_first_name',
      'auctioned.last_name as auctioned_last_name',
      'buyer.first_name as buyer_first_name',
      'buyer.last_name as buyer_last_name',
      'owner.first_name as owner_first_name',
      'owner.last_name as owner_last_name'
    );

  const totalPlayers = activePlayers.length;
  const drawnPlayers = sales.length;
  const missingOwnerCount = sales.filter((row) => !row.owner_user_id).length;
  const finalized = totalPlayers > 0 && drawnPlayers === totalPlayers && missingOwnerCount === 0;
  const poolTotal = sales.reduce((sum, row) => sum + (Number(row.auction_bid_amount || 0) * 0.5), 0);

  const balanceByUser = new Map();
  for (const player of activePlayers) {
    balanceByUser.set(Number(player.id), {
      userId: Number(player.id),
      name: `${player.first_name || ''} ${player.last_name || ''}`.trim(),
      purchasesOwed: 0,
      ownershipReceivable: 0,
      netBalance: 0
    });
  }

  for (const sale of sales) {
    const price = Number(sale.auction_bid_amount || 0);
    const ownerShare = price * 0.5;
    const buyerId = Number(sale.buyer_user_id || 0);
    const ownerId = Number(sale.owner_user_id || 0);
    if (buyerId && balanceByUser.has(buyerId)) {
      const current = balanceByUser.get(buyerId);
      current.purchasesOwed += price;
      current.netBalance -= price;
    }
    if (ownerId && balanceByUser.has(ownerId)) {
      const current = balanceByUser.get(ownerId);
      current.ownershipReceivable += ownerShare;
      current.netBalance += ownerShare;
    }
  }

  const balances = [...balanceByUser.values()]
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const viewerBalance = balances.find((row) => Number(row.userId) === Number(viewerUserId || 0)) || null;

  const rows = sales.map((sale) => ({
    id: Number(sale.id),
    drawOrder: Number(sale.draw_order || 0),
    auctionedUserId: Number(sale.auctioned_user_id || 0),
    buyerUserId: Number(sale.buyer_user_id || 0),
    ownerUserId: Number(sale.owner_user_id || 0),
    playerName: `${sale.auctioned_first_name || ''} ${sale.auctioned_last_name || ''}`.trim(),
    buyerName: `${sale.buyer_first_name || ''} ${sale.buyer_last_name || ''}`.trim(),
    ownerName: sale.owner_user_id ? `${sale.owner_first_name || ''} ${sale.owner_last_name || ''}`.trim() : '-',
    price: Number(sale.auction_bid_amount || 0),
    ownerShare: Number(sale.auction_bid_amount || 0) * 0.5,
    poolShare: Number(sale.auction_bid_amount || 0) * 0.5
  }));

  return {
    finalized,
    totalPlayers,
    drawnPlayers,
    missingOwnerCount,
    poolTotal,
    rows,
    balances,
    viewerBalance,
    participantsById
  };
}

function buildCalcuttaPayouts(event, calcuttaSummary, stablefordByDay, championshipTable, publishedDays) {
  const out = {
    enabled: false,
    totalPayout: 0,
    rows: [],
    personalPayoutByUserId: new Map()
  };
  if (!event || !calcuttaSummary || !calcuttaSummary.finalized) return out;
  const publishedSet = new Set((publishedDays || []).map(Number));
  if (!publishedSet.has(4)) return out;
  const champion = (championshipTable || [])[0];
  if (!champion || !Number(champion.userId || 0)) return out;

  const byAuctionedUser = new Map(
    (calcuttaSummary.rows || [])
      .map((row) => [Number(row.auctionedUserId || 0), row])
      .filter(([id]) => Number.isInteger(id) && id > 0)
  );
  const byUserName = calcuttaSummary.participantsById || new Map();
  const poolTotal = Number(calcuttaSummary.poolTotal || 0);
  if (!Number.isFinite(poolTotal) || poolTotal <= 0) return out;

  const ownerDailyWinnerPercent = Number(event.calcutta_owner_daily_winner_percent || 0);
  const championPercent = Number(event.calcutta_champion_percent || 0);
  const championOwnerPercent = Number(event.calcutta_champion_owner_percent || 0);
  const mysteryPlacePercent = Number(event.calcutta_mystery_place_percent || 0);
  const mysteryPlace = Number(event.calcutta_mystery_place || 0);

  const push = (category, basisPlayerUserId, recipientUserId, pct) => {
    const percent = Number(pct || 0);
    if (!Number.isFinite(percent) || percent <= 0) return;
    const amount = (poolTotal * percent) / 100;
    const basisName = basisPlayerUserId && byUserName.has(Number(basisPlayerUserId))
      ? byUserName.get(Number(basisPlayerUserId)).name
      : '-';
    const recipientName = recipientUserId && byUserName.has(Number(recipientUserId))
      ? byUserName.get(Number(recipientUserId)).name
      : '-';
    out.rows.push({
      category,
      basisName,
      recipientName,
      percent,
      amount
    });
    if (Number.isInteger(Number(recipientUserId)) && Number(recipientUserId) > 0) {
      out.personalPayoutByUserId.set(
        Number(recipientUserId),
        Number(out.personalPayoutByUserId.get(Number(recipientUserId)) || 0) + amount
      );
    }
  };

  [2, 3, 4].forEach((day) => {
    const dailyWinner = (stablefordByDay?.[day] || [])[0];
    if (!dailyWinner) return;
    const sale = byAuctionedUser.get(Number(dailyWinner.userId || 0));
    if (!sale || !Number(sale.buyerUserId || 0)) return;
    push(`Owner Daily Winner (${dayLabel(day)})`, Number(dailyWinner.userId), Number(sale.buyerUserId), ownerDailyWinnerPercent);
  });

  const championSale = byAuctionedUser.get(Number(champion.userId || 0));
  if (championSale) {
    if (Number(champion.userId || 0) > 0) {
      push('Champion', Number(champion.userId), Number(champion.userId), championPercent);
    }
    if (Number(championSale.buyerUserId || 0) > 0) {
      push('Champion Owner', Number(champion.userId), Number(championSale.buyerUserId), championOwnerPercent);
    }
  }

  if (mysteryPlace > 0) {
    const mysteryRow = (championshipTable || []).find((row) => Number(row.position || 0) === mysteryPlace);
    if (mysteryRow) {
      const mysterySale = byAuctionedUser.get(Number(mysteryRow.userId || 0));
      if (mysterySale && Number(mysterySale.buyerUserId || 0) > 0) {
        push(`Mystery Place #${mysteryPlace}`, Number(mysteryRow.userId), Number(mysterySale.buyerUserId), mysteryPlacePercent);
      }
    }
  }

  out.totalPayout = out.rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  out.enabled = out.rows.length > 0;
  return out;
}

function buildChampionshipTable(stablefordBoards) {
  const byDay = stablefordBoards?.byDay || {};
  const championshipRows = Array.isArray(stablefordBoards?.championship) ? stablefordBoards.championship : [];
  const r1ByUser = new Map((byDay[2] || []).map((row) => [Number(row.userId), Number(row.total || 0)]));
  const r2ByUser = new Map((byDay[3] || []).map((row) => [Number(row.userId), Number(row.total || 0)]));
  const r3ByUser = new Map((byDay[4] || []).map((row) => [Number(row.userId), Number(row.total || 0)]));

  const totalCount = new Map();
  championshipRows.forEach((row) => {
    const key = Number(row.total || 0);
    totalCount.set(key, Number(totalCount.get(key) || 0) + 1);
  });

  return championshipRows.map((row) => {
    const userId = Number(row.userId || 0);
    const total = Number(row.total || 0);
    return {
      position: Number(row.position || 0),
      userId,
      name: row.name,
      r1: Number(r1ByUser.get(userId) || 0),
      r2: Number(r2ByUser.get(userId) || 0),
      r3: Number(r3ByUser.get(userId) || 0),
      total,
      cb9: Number(row.countbackLast9 || 0),
      cb6: Number(row.countbackLast6 || 0),
      cb3: Number(row.countbackLast3 || 0),
      cb1: Number(row.countbackLast1 || 0),
      countbackUsed: Number(totalCount.get(total) || 0) > 1
    };
  });
}

function normalizeSkins(holes, visibleDays) {
  const daySet = new Set((visibleDays || []).map(Number));
  const filteredHoles = (holes || []).filter((hole) => daySet.has(Number(hole.day)));
  const byDay = new Map();
  for (const hole of filteredHoles) {
    if (!byDay.has(Number(hole.day))) {
      byDay.set(Number(hole.day), {
        day: Number(hole.day),
        wins: [],
        winners: []
      });
    }
    if (hole.status !== 'won' || !hole.winning_participant_id || !hole.winner_name) continue;
    const row = byDay.get(Number(hole.day));
    const basePot = Number(hole.base_pot_amount || 0);
    const totalPot = Number(hole.total_pot_amount || 0);
    const skinsCount = basePot > 0 ? Math.round(totalPot / basePot) : 0;
    row.wins.push({
      day: Number(hole.day),
      holeNumber: Number(hole.hole_number),
      name: hole.winner_name,
      participantType: hole.participant_type,
      gross: hole.winning_gross == null ? null : Number(hole.winning_gross),
      stableford: hole.winning_stableford == null ? null : Number(hole.winning_stableford),
      skinsCount
    });
  }

  const daily = [...byDay.values()]
    .sort((a, b) => a.day - b.day)
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

  return {
    holes: filteredHoles,
    daily
  };
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
        day: Number(hole.day || 0),
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

  return {
    playerRows: aggregate('player'),
    teamRows: aggregate('team')
  };
}

function buildSkinsCarryovers(holes) {
  const byDay = new Map();
  (holes || []).forEach((hole) => {
    const day = Number(hole.day || 0);
    if (!day) return;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(hole);
  });

  return [...byDay.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([day, dayHoles]) => {
      const hole1 = dayHoles.find((h) => Number(h.hole_number || 0) === 1);
      const hole18 = dayHoles.find((h) => Number(h.hole_number || 0) === 18);
      const basePotIn = Number(hole1?.base_pot_amount || 0);
      const carryInAmount = Number(hole1?.carry_in_amount || 0);
      const carryInSkins = basePotIn > 0 ? Math.round(carryInAmount / basePotIn) : 0;

      const basePotOut = Number(hole18?.base_pot_amount || 0);
      const totalPotOut = Number(hole18?.total_pot_amount || 0);
      const carryOutSkins = hole18 && String(hole18.status || '') !== 'won' && basePotOut > 0
        ? Math.round(totalPotOut / basePotOut)
        : 0;

      return {
        day: Number(day),
        carryInSkins: Math.max(0, Number(carryInSkins || 0)),
        carryOutSkins: Math.max(0, Number(carryOutSkins || 0))
      };
    })
    .filter((row) => Number(row.carryInSkins || 0) > 0 || Number(row.carryOutSkins || 0) > 0);
}

function buildChampionshipFromVisibleDays(stablefordByDay, visibleDays) {
  const visibleSet = new Set((visibleDays || []).map(Number));
  const byUser = new Map();
  [2, 3, 4].forEach((day) => {
    if (!visibleSet.has(day)) return;
    (stablefordByDay?.[day] || []).forEach((row) => {
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

  return [...byUser.values()]
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

async function getPlayerMetaByUserIds(db, eventId, userIds) {
  const ids = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return {};
  const rows = await db('users as u')
    .join('event_players as ep', function joinEventPlayers() {
      this.on('ep.user_id', '=', 'u.id').andOnVal('ep.event_id', '=', eventId);
    })
    .leftJoin('player_handicaps as ph', function joinHandicap() {
      this.on('ph.user_id', '=', 'u.id').andOnVal('ph.event_id', '=', eventId);
    })
    .whereIn('u.id', ids)
    .select('u.id', 'u.first_name', 'u.last_name', 'u.is_previous_winner', 'ep.is_previous_year_winner', 'ph.playing_handicap');

  const meta = {};
  rows.forEach((row) => {
    const userId = Number(row.id);
    meta[userId] = {
      userId,
      name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
      handicap: row.playing_handicap == null ? null : Math.trunc(Number(row.playing_handicap)),
      isPreviousWinner: Number(row.is_previous_winner || 0) === 1,
      isDefendingChampion: Number(row.is_previous_year_winner || 0) === 1
    };
  });
  return meta;
}

async function getDefaultCourseId(db) {
  const row = await db('courses').orderBy('id', 'asc').first();
  return row ? Number(row.id) : null;
}

async function getDayPublicationRows(db, eventId) {
  const rows = await db('event_day_statuses')
    .where({ event_id: eventId })
    .whereIn('day', [1, 2, 3, 4])
    .select('day', 'status', 'leaderboard_published', 'calc_type');
  const byDay = new Map(rows.map((r) => [Number(r.day), r]));
  return [1, 2, 3, 4].map((day) => {
    const row = byDay.get(day);
    return {
      day,
      status: row?.status || 'draft',
      calcType: row?.calc_type || defaultCalcTypeForDay(day),
      leaderboardPublished: Number(row?.leaderboard_published || 0) === 1
    };
  });
}

async function getDayFinalizationRows(db, eventId) {
  const rows = await db('scorecards')
    .where({ event_id: eventId })
    .whereIn('day', [1, 2, 3, 4])
    .groupBy('day')
    .select('day')
    .count({ total: '*' })
    .sum({
      submitted: db.raw(`CASE WHEN status = 'submitted' THEN 1 ELSE 0 END`)
    });
  const byDay = new Map(
    rows.map((r) => [
      Number(r.day),
      {
        total: Number(r.total || 0),
        submitted: Number(r.submitted || 0)
      }
    ])
  );
  return [1, 2, 3, 4].map((day) => {
    const row = byDay.get(day) || { total: 0, submitted: 0 };
    return {
      day,
      total: row.total,
      submitted: row.submitted,
      isFinalized: row.total > 0 && row.submitted === row.total
    };
  });
}

function dayToRoundLabel(day) {
  if (Number(day) === 2) return 'R1';
  if (Number(day) === 3) return 'R2';
  if (Number(day) === 4) return 'R3';
  return dayLabel(day);
}

function toScorecardMatrixModel(base) {
  const holes = (base.holes || []).map((h) => ({
    holeNumber: Number(h.holeNumber),
    par: Number(h.par || 0),
    siPrimary: Number(h.siPrimary || 0),
    gross: h.gross == null ? null : Number(h.gross),
    net: h.net == null ? null : Number(h.net),
    stableford: h.stableford == null ? null : Number(h.stableford)
  }));
  const front9 = holes.filter((h) => h.holeNumber >= 1 && h.holeNumber <= 9).sort((a, b) => a.holeNumber - b.holeNumber);
  const back9 = holes.filter((h) => h.holeNumber >= 10 && h.holeNumber <= 18).sort((a, b) => a.holeNumber - b.holeNumber);
  return {
    ...base,
    holes,
    front9,
    back9
  };
}

function summarizeTotals(holes) {
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

async function getCourseHolesForDay(db, eventId, day) {
  return db('event_day_statuses as eds')
    .join('holes as h', 'h.course_id', 'eds.course_id')
    .where({ 'eds.event_id': eventId, 'eds.day': day })
    .orderBy('h.hole_number', 'asc')
    .select('h.hole_number', 'h.par', 'h.stroke_index_primary', 'h.stroke_index_secondary');
}

async function getPublishedDaySet(db, eventId) {
  const rows = await getDayPublicationRows(db, eventId);
  return new Set(rows.filter((r) => r.leaderboardPublished).map((r) => Number(r.day)));
}

function ambroseAllowance(memberCount) {
  if (Number(memberCount) === 2) return 1 / 4;
  if (Number(memberCount) === 3) return 1 / 3;
  return 0;
}

function formatHandicapDisplay(raw) {
  if (raw === null || raw === undefined || raw === '') return '-';
  const num = Number(raw);
  if (!Number.isFinite(num)) return '-';
  const abs = Number.isInteger(num) ? String(Math.abs(num)) : String(Math.abs(num).toFixed(1)).replace(/\\.0$/, '');
  return num < 0 ? `+${abs}` : abs;
}

async function getAmbroseTeamMembersByTeamId(db, eventId, teamIds) {
  const ids = [...new Set((teamIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return {};

  const rows = await db('team_members as tm')
    .join('users as u', 'u.id', 'tm.user_id')
    .leftJoin('player_handicaps as ph', function joinHcp() {
      this.on('ph.user_id', '=', 'u.id').andOnVal('ph.event_id', '=', eventId);
    })
    .leftJoin('event_players as ep', function joinEventPlayer() {
      this.on('ep.user_id', '=', 'u.id').andOnVal('ep.event_id', '=', eventId);
    })
    .whereIn('tm.team_id', ids)
    .orderBy([{ column: 'tm.team_id', order: 'asc' }, { column: 'u.last_name', order: 'asc' }, { column: 'u.first_name', order: 'asc' }])
    .select(
      'tm.team_id',
      'tm.is_dual_assigned',
      'u.id',
      'u.first_name',
      'u.last_name',
      'u.is_previous_winner',
      'ep.is_previous_year_winner',
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
      is_previous_winner: Number(row.is_previous_winner || 0) === 1,
      is_previous_year_winner: Number(row.is_previous_year_winner || 0) === 1,
      is_dual_assigned: Number(row.is_dual_assigned || 0) === 1
    });
  });
  return out;
}

async function getSultansTeamMembersByTeamId(db, eventId, teamIds) {
  return getAmbroseTeamMembersByTeamId(db, eventId, teamIds);
}

async function buildIndividualScorecardModel(db, event, day, userId) {
  const [scorecard, user, handicap, holeConfig, holeScores, dayStatus] = await Promise.all([
    db('scorecards').where({ event_id: event.id, day, type: 'individual', user_id: userId }).first(),
    db('users').where({ id: userId }).first(),
    db('player_handicaps').where({ event_id: event.id, user_id: userId }).first(),
    getCourseHolesForDay(db, event.id, day),
    db('scorecards as s')
      .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
      .where({ 's.event_id': event.id, 's.day': day, 's.type': 'individual', 's.user_id': userId })
      .select('sh.hole_number', 'sh.gross_score', 'sh.stableford_points'),
    db('event_day_statuses').where({ event_id: event.id, day }).first()
  ]);
  if (!scorecard || !user || !holeConfig.length) return null;

  const hcp = Math.trunc(Number(handicap?.playing_handicap || 0));
  const byHole = new Map(holeScores.map((row) => [Number(row.hole_number), row]));
  const holes = holeConfig.map((hole) => {
    const saved = byHole.get(Number(hole.hole_number));
    const gross = saved ? Number(saved.gross_score) : null;
    const shots = strokesForHole(hcp, Number(hole.stroke_index_primary), Number(hole.stroke_index_secondary));
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

  const calcType = String(dayStatus?.calc_type || defaultCalcTypeForDay(day));
  const totals = summarizeTotals(holes);
  const resultLabel = calcType === CALC_TYPES.STABLEFORD
    ? `${totals.stablefordTotal} pts`
    : `${totals.grossTotal} gross / ${totals.netTotal} net`;

  return toScorecardMatrixModel({
    mode: 'individual',
    day,
    roundLabel: dayToRoundLabel(day),
    dayLabel: dayLabel(day),
    calcType,
    showStablefordTotals: calcType === CALC_TYPES.STABLEFORD,
    showGrossOnlyTotals: calcType !== CALC_TYPES.STABLEFORD,
    title: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
    subtitle: `Hcp ${hcp}`,
    resultLabel,
    totals,
    holes
  });
}

async function buildAmbroseScorecardModel(db, event, teamId) {
  const scorecard = await db('scorecards as s')
    .join('teams as t', 't.id', 's.team_id')
    .where({ 's.event_id': event.id, 's.type': 'team', 't.id': teamId })
    .select('s.id', 's.day', 's.team_id', 't.name as team_name')
    .first();
  if (!scorecard) return null;

  const day = Number(scorecard.day);
  const [holeConfig, holeScores, memberRows, dayStatus] = await Promise.all([
    getCourseHolesForDay(db, event.id, day),
    db('scorecard_holes')
      .where({ scorecard_id: scorecard.id })
      .select('hole_number', 'gross_score', 'stableford_points'),
    db('team_members as tm')
      .join('users as u', 'u.id', 'tm.user_id')
      .leftJoin('player_handicaps as ph', function joinPh() {
        this.on('ph.user_id', '=', 'tm.user_id').andOnVal('ph.event_id', '=', event.id);
      })
      .where({ 'tm.team_id': teamId })
      .select('u.first_name', 'u.last_name', 'ph.playing_handicap'),
    db('event_day_statuses').where({ event_id: event.id, day }).first()
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

  const calcType = String(dayStatus?.calc_type || defaultCalcTypeForDay(day));
  const totals = summarizeTotals(holes);
  const netExact = totals.grossTotal - exactTeamHandicap;
  const membersLabel = memberRows
    .map((m) => `${m.first_name || ''} ${m.last_name || ''}`.trim())
    .filter(Boolean)
    .join(', ');

  return toScorecardMatrixModel({
    mode: 'team',
    day,
    roundLabel: dayToRoundLabel(day),
    dayLabel: dayLabel(day),
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

async function buildSultansScorecardModel(db, event, teamId, day) {
  const team = await db('teams')
    .where({ id: teamId, event_id: event.id, day: 2, competition_type: 'sultans' })
    .first();
  if (!team) return null;

  const [holeConfig, memberRows] = await Promise.all([
    getCourseHolesForDay(db, event.id, day),
    db('team_members as tm')
      .join('users as u', 'u.id', 'tm.user_id')
      .where({ 'tm.team_id': teamId })
      .select('u.id', 'u.first_name', 'u.last_name')
  ]);
  if (!holeConfig.length || !memberRows.length) return null;

  const memberIds = memberRows.map((m) => Number(m.id));
  const holeRows = await db('scorecards as s')
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .where({ 's.event_id': event.id, 's.type': 'individual', 's.day': day })
    .whereIn('s.user_id', memberIds)
    .select('s.user_id', 'sh.hole_number', 'sh.stableford_points');

  const pointsByUserHole = new Map();
  holeRows.forEach((row) => {
    pointsByUserHole.set(`${Number(row.user_id)}:${Number(row.hole_number)}`, Number(row.stableford_points || 0));
  });

  const holes = holeConfig.map((hole) => {
    const holeNo = Number(hole.hole_number);
    const values = memberIds
      .map((userId) => Number(pointsByUserHole.get(`${userId}:${holeNo}`) || 0))
      .sort((a, b) => b - a);
    const bestThree = values.slice(0, 3);
    const stableford = bestThree.reduce((sum, p) => sum + Number(p || 0), 0);
    return {
      holeNumber: holeNo,
      par: Number(hole.par || 0),
      siPrimary: Number(hole.stroke_index_primary || 0),
      siSecondary: Number(hole.stroke_index_secondary || 0),
      gross: null,
      net: null,
      stableford
    };
  });

  const totals = summarizeTotals(holes);
  const subtitle = memberRows.map((m) => `${m.first_name || ''} ${m.last_name || ''}`.trim()).join(', ');
  return toScorecardMatrixModel({
    mode: 'team',
    day,
    roundLabel: `Sultans ${dayToRoundLabel(day)}`,
    dayLabel: dayLabel(day),
    calcType: CALC_TYPES.STABLEFORD,
    showStablefordTotals: true,
    showGrossOnlyTotals: false,
    title: team.name || 'Sultans Team',
    subtitle,
    resultLabel: `${Number(totals.stablefordTotal || 0)} pts`,
    totals,
    holes
  });
}

async function buildEclecticScorecardModel(db, event, userId, days = [2, 3, 4]) {
  const scopedDays = (Array.isArray(days) ? days : [2, 3, 4])
    .map((d) => Number(d))
    .filter((d) => [2, 3, 4].includes(d));
  if (!scopedDays.length) return null;

  const [user, handicap] = await Promise.all([
    db('users').where({ id: userId }).first(),
    db('player_handicaps').where({ event_id: event.id, user_id: userId }).first()
  ]);
  if (!user) return null;

  const configDay = [...scopedDays].sort((a, b) => a - b)[0];
  const holeConfig = await getCourseHolesForDay(db, event.id, configDay);
  if (!holeConfig.length) return null;

  const rows = await db('scorecards as s')
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .where({ 's.event_id': event.id, 's.type': 'individual', 's.user_id': userId })
    .whereIn('s.day', scopedDays)
    .select('s.day', 'sh.hole_number', 'sh.gross_score', 'sh.stableford_points');

  const bestByHole = new Map();
  for (const row of rows) {
    const hole = Number(row.hole_number);
    const stableford = Number(row.stableford_points || 0);
    const gross = Number(row.gross_score || 0);
    const day = Number(row.day || 0);
    if (!bestByHole.has(hole)) {
      bestByHole.set(hole, { hole, stableford, gross, day });
      continue;
    }
    const current = bestByHole.get(hole);
    // Primary: best stableford. Tie-break: lower gross. Then earlier round.
    if (
      stableford > Number(current.stableford || 0) ||
      (stableford === Number(current.stableford || 0) && gross < Number(current.gross || 0)) ||
      (stableford === Number(current.stableford || 0) && gross === Number(current.gross || 0) && day < Number(current.day || 0))
    ) {
      bestByHole.set(hole, { hole, stableford, gross, day });
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
    day: configDay,
    roundLabel: 'Eclectic',
    dayLabel: 'Rounds 1-3',
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

function leaderboardRouter(db) {
  const router = express.Router();

  router.post('/publish/:day', requireAuth, async (req, res, next) => {
    try {
      const day = Number(req.params.day);
      if (![1, 2, 3, 4].includes(day)) return res.redirect('/leaderboards?error=Invalid%20day');
      if (!isPrivileged(req.session?.user)) return res.status(403).send('Forbidden');

      const active = await db('events').where({ is_active: 1 }).first();
      if (!active) return res.redirect('/leaderboards?error=No%20active%20event');

      const finalizedRows = await getDayFinalizationRows(db, active.id);
      const target = finalizedRows.find((row) => row.day === day);
      if (!target || !target.isFinalized) {
        return res.redirect(`/leaderboards?error=${encodeURIComponent(`${dayLabel(day)} is not finalized`)}`);
      }

      const existing = await db('event_day_statuses').where({ event_id: active.id, day }).first();
      if (existing) {
        await db('event_day_statuses')
          .where({ id: existing.id })
          .update({ leaderboard_published: 1, updated_at: db.fn.now() });
      } else {
        const defaultCourseId = await getDefaultCourseId(db);
        if (!defaultCourseId) return res.redirect('/leaderboards?error=No%20courses%20configured');
        await db('event_day_statuses').insert({
          event_id: active.id,
          day,
          status: 'draft',
          calc_type: defaultCalcTypeForDay(day),
          leaderboard_published: 1,
          course_id: defaultCourseId
        });
      }

      return res.redirect(`/leaderboards?message=${encodeURIComponent(`${dayLabel(day)} published`)}`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/unpublish/:day', requireAuth, async (req, res, next) => {
    try {
      const day = Number(req.params.day);
      if (![1, 2, 3, 4].includes(day)) return res.redirect('/leaderboards?error=Invalid%20day');
      if (!isPrivileged(req.session?.user)) return res.status(403).send('Forbidden');

      const active = await db('events').where({ is_active: 1 }).first();
      if (!active) return res.redirect('/leaderboards?error=No%20active%20event');

      const existing = await db('event_day_statuses').where({ event_id: active.id, day }).first();
      if (existing) {
        await db('event_day_statuses')
          .where({ id: existing.id })
          .update({ leaderboard_published: 0, updated_at: db.fn.now() });
      } else {
        const defaultCourseId = await getDefaultCourseId(db);
        if (!defaultCourseId) return res.redirect('/leaderboards?error=No%20courses%20configured');
        await db('event_day_statuses').insert({
          event_id: active.id,
          day,
          status: 'draft',
          calc_type: defaultCalcTypeForDay(day),
          leaderboard_published: 0,
          course_id: defaultCourseId
        });
      }

      return res.redirect(`/leaderboards?message=${encodeURIComponent(`${dayLabel(day)} unpublished`)}`);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/event/:eventId/scorecards/individual/:userId', requireAuth, async (req, res, next) => {
    try {
      const eventId = Number(req.params.eventId);
      const userId = Number(req.params.userId);
      const day = Number(req.query.day || 2);
      if (!Number.isInteger(eventId) || eventId <= 0) return res.redirect('/leaderboards?error=Invalid%20event');
      if (!Number.isInteger(userId) || userId <= 0) return res.redirect(`/leaderboards/event/${eventId}?error=Invalid%20player`);
      if (![2, 3, 4].includes(day)) return res.redirect(`/leaderboards/event/${eventId}?error=Invalid%20round`);

      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/leaderboards?error=Event%20not%20found');
      const publishedDays = await getPublishedDaySet(db, eventId);
      if (!publishedDays.has(day)) return res.redirect(`/leaderboards/event/${eventId}?error=Round%20not%20published`);

      const scorecardModel = await buildIndividualScorecardModel(db, event, day, userId);
      if (!scorecardModel) return res.redirect(`/leaderboards/event/${eventId}?error=Scorecard%20not%20found`);

      return res.render('leaderboard/scorecard-view', {
        title: `${scorecardModel.title} ${dayToRoundLabel(day)} Scorecard`,
        user: req.session.user,
        activeEvent: event,
        models: [scorecardModel],
        backUrl: `/leaderboards/event/${eventId}?view=championship`,
        pageSubtitle: `${event.year} · ${event.location}`
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/event/:eventId/scorecards/team/:teamId', requireAuth, async (req, res, next) => {
    try {
      const eventId = Number(req.params.eventId);
      const teamId = Number(req.params.teamId);
      if (!Number.isInteger(eventId) || eventId <= 0) return res.redirect('/leaderboards?error=Invalid%20event');
      if (!Number.isInteger(teamId) || teamId <= 0) return res.redirect(`/leaderboards/event/${eventId}?error=Invalid%20team`);

      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/leaderboards?error=Event%20not%20found');

      const scorecardModel = await buildAmbroseScorecardModel(db, event, teamId);
      if (!scorecardModel) return res.redirect(`/leaderboards/event/${eventId}?error=Scorecard%20not%20found`);

      const publishedDays = await getPublishedDaySet(db, eventId);
      if (!publishedDays.has(Number(scorecardModel.day))) {
        return res.redirect(`/leaderboards/event/${eventId}?error=Ambrose%20not%20published`);
      }

      return res.render('leaderboard/scorecard-view', {
        title: `${scorecardModel.title} ${scorecardModel.dayLabel} Scorecard`,
        user: req.session.user,
        activeEvent: event,
        models: [scorecardModel],
        backUrl: `/leaderboards/event/${eventId}?view=ambrose`,
        pageSubtitle: `${event.year} · ${event.location}`
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/event/:eventId/scorecards/championship/:userId', requireAuth, async (req, res, next) => {
    try {
      const eventId = Number(req.params.eventId);
      const userId = Number(req.params.userId);
      if (!Number.isInteger(eventId) || eventId <= 0) return res.redirect('/leaderboards?error=Invalid%20event');
      if (!Number.isInteger(userId) || userId <= 0) return res.redirect(`/leaderboards/event/${eventId}?error=Invalid%20player`);

      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/leaderboards?error=Event%20not%20found');
      const publishedDays = await getPublishedDaySet(db, eventId);
      const rounds = [2, 3, 4].filter((day) => publishedDays.has(day));
      if (!rounds.length) return res.redirect(`/leaderboards/event/${eventId}?error=No%20published%20rounds`);

      const modelsRaw = await Promise.all(rounds.map((day) => buildIndividualScorecardModel(db, event, day, userId)));
      const models = modelsRaw.filter(Boolean);
      if (!models.length) return res.redirect(`/leaderboards/event/${eventId}?error=No%20scorecards%20found`);

      const playerName = models[0].title;
      return res.render('leaderboard/scorecard-view', {
        title: `${playerName} Championship Cards`,
        user: req.session.user,
        activeEvent: event,
        models,
        backUrl: `/leaderboards/event/${eventId}?view=championship`,
        pageSubtitle: `${event.year} · ${event.location} · Championship`
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/event/:eventId/scorecards/sultans/:teamId', requireAuth, async (req, res, next) => {
    try {
      const eventId = Number(req.params.eventId);
      const teamId = Number(req.params.teamId);
      if (!Number.isInteger(eventId) || eventId <= 0) return res.redirect('/leaderboards?error=Invalid%20event');
      if (!Number.isInteger(teamId) || teamId <= 0) return res.redirect(`/leaderboards/event/${eventId}?error=Invalid%20team`);

      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/leaderboards?error=Event%20not%20found');
      const publishedDays = await getPublishedDaySet(db, eventId);
      const rounds = [2, 3, 4].filter((day) => publishedDays.has(day));
      if (rounds.length < 2) return res.redirect(`/leaderboards/event/${eventId}?view=sultans&error=Sultans%20is%20available%20after%20Round%202`);

      const modelsRaw = await Promise.all(rounds.map((day) => buildSultansScorecardModel(db, event, teamId, day)));
      const models = modelsRaw.filter(Boolean);
      if (!models.length) return res.redirect(`/leaderboards/event/${eventId}?view=sultans&error=Sultans%20scorecard%20not%20found`);

      return res.render('leaderboard/scorecard-view', {
        title: `${models[0].title} Sultans Scorecard`,
        user: req.session.user,
        activeEvent: event,
        models,
        backUrl: `/leaderboards/event/${eventId}?view=sultans`,
        pageSubtitle: `${event.year} · ${event.location} · Sultans`
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/event/:eventId/scorecards/eclectic/:userId', requireAuth, async (req, res, next) => {
    try {
      const eventId = Number(req.params.eventId);
      const userId = Number(req.params.userId);
      if (!Number.isInteger(eventId) || eventId <= 0) return res.redirect('/leaderboards?error=Invalid%20event');
      if (!Number.isInteger(userId) || userId <= 0) return res.redirect(`/leaderboards/event/${eventId}?error=Invalid%20player`);

      const event = await db('events').where({ id: eventId }).first();
      if (!event) return res.redirect('/leaderboards?error=Event%20not%20found');

      const publishedDays = await getPublishedDaySet(db, eventId);
      const scopedDays = [2, 3, 4].filter((day) => publishedDays.has(day));
      if (scopedDays.length < 2) {
        return res.redirect(`/leaderboards/event/${eventId}?view=eclectic&error=Eclectic%20is%20available%20after%20Round%202`);
      }

      const scorecardModel = await buildEclecticScorecardModel(db, event, userId, scopedDays);
      if (!scorecardModel) return res.redirect(`/leaderboards/event/${eventId}?view=eclectic&error=Eclectic%20scorecard%20not%20found`);

      return res.render('leaderboard/scorecard-view', {
        title: `${scorecardModel.title} Eclectic Scorecard`,
        user: req.session.user,
        activeEvent: event,
        models: [scorecardModel],
        backUrl: `/leaderboards/event/${eventId}?view=eclectic`,
        pageSubtitle: `${event.year} · ${event.location} · Eclectic`
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/event/:eventId', requireAuth, async (req, res, next) => {
    try {
      const viewer = req.session.user;
      const eventId = Number(req.params.eventId);
      if (!Number.isInteger(eventId) || eventId <= 0) {
        return res.redirect('/admin/dashboard?error=Invalid%20event');
      }

      const event = await db('events').where({ id: eventId }).first();
      if (!event) {
        return res.redirect('/admin/dashboard?error=Event%20not%20found');
      }

      const [publicationRows, finalizationRows, calcuttaSummary] = await Promise.all([
        getDayPublicationRows(db, event.id),
        getDayFinalizationRows(db, event.id),
        getCalcuttaSummary(db, event.id, viewer?.id)
      ]);
      const requestedView = normalizeLeaderboardView(req.query.view);
      const activeView = requestedView === 'calcutta' && !calcuttaSummary.finalized
        ? 'championship'
        : requestedView;

      const dayStates = [1, 2, 3, 4].map((day) => {
        const pub = publicationRows.find((r) => r.day === day) || { day, status: 'draft', leaderboardPublished: false };
        const fin = finalizationRows.find((r) => r.day === day) || { day, total: 0, submitted: 0, isFinalized: false };
        return {
          day,
          label: dayLabel(day),
          status: pub.status,
          leaderboardPublished: pub.leaderboardPublished,
          total: fin.total,
          submitted: fin.submitted,
          isFinalized: fin.isFinalized
        };
      });

      const finalizedDays = dayStates.filter((d) => d.isFinalized).map((d) => d.day);
      const publishedDays = dayStates.filter((d) => d.leaderboardPublished).map((d) => d.day);
      const boards = await buildLeaderboards(db, event.id, { finalizedDaysForSkins: finalizedDays });
      const visibleDays = publishedDays;
      const visibleIndividualDays = visibleDays.filter((day) => [2, 3, 4].includes(day));
      const showAggregate = visibleIndividualDays.length > 0;
      const showEclectic = visibleIndividualDays.length >= 2;
      const showSultans = visibleIndividualDays.length >= 2;
      const skinsNormalized = normalizeSkins(boards.skins.holes, visibleDays);
      const championship =
        showAggregate
          ? buildChampionshipFromVisibleDays(boards.stableford?.byDay || {}, visibleIndividualDays)
          : [];
      const [eclecticTop, sultansTop] = showAggregate
        ? await Promise.all([
            showEclectic ? calculateEclecticLeaderboard(db, event.id, visibleIndividualDays) : Promise.resolve([]),
            showSultans ? calculateSultansLeaderboard(db, event.id, visibleIndividualDays) : Promise.resolve([])
          ])
        : [[], []];

      const visibleBoards = {
        ...boards,
        ambrose: visibleDays.includes(1) ? boards.ambrose : [],
        stableford: {
          byDay: {
            2: visibleDays.includes(2) ? (boards.stableford?.byDay?.[2] || []) : [],
            3: visibleDays.includes(3) ? (boards.stableford?.byDay?.[3] || []) : [],
            4: visibleDays.includes(4) ? (boards.stableford?.byDay?.[4] || []) : []
          },
          championship
        },
        eclectic: showEclectic ? eclecticTop : [],
        sultans: showSultans ? sultansTop : [],
        skins: {
          ...boards.skins,
          holes: skinsNormalized.holes,
          daily: skinsNormalized.daily
        }
      };
      const skinPotPerHole = Number(visibleBoards.skins.activePlayerCount || 0) * Number(event.skins_amount_per_player_per_hole || 1);
      const skinsLeaderboard = buildSkinsLeaderboard(visibleBoards.skins.holes, skinPotPerHole);
      const skinsCarryovers = buildSkinsCarryovers(visibleBoards.skins.holes);
      const championshipTable = buildChampionshipTable(visibleBoards.stableford);
      const calcuttaPayouts = buildCalcuttaPayouts(
        event,
        calcuttaSummary,
        visibleBoards.stableford?.byDay || {},
        championshipTable,
        publishedDays
      );
      if (calcuttaPayouts.enabled) {
        const viewerId = Number(viewer?.id || 0);
        const personalPayout = Number(calcuttaPayouts.personalPayoutByUserId.get(viewerId) || 0);
        if (calcuttaSummary.viewerBalance) {
          calcuttaSummary.viewerBalance.personalPayout = personalPayout;
          calcuttaSummary.viewerBalance.netAfterPayout = Number(calcuttaSummary.viewerBalance.netBalance || 0) + personalPayout;
        }
      }
      calcuttaSummary.payouts = calcuttaPayouts;
      const userIdsNeedingMeta = [
        ...championshipTable.map((row) => Number(row.userId)),
        ...(visibleBoards.eclectic || []).map((row) => Number(row.userId))
      ];
      const playerMetaById = await getPlayerMetaByUserIds(db, event.id, userIdsNeedingMeta);
      const ambroseTeamMembersById = await getAmbroseTeamMembersByTeamId(
        db,
        event.id,
        (visibleBoards.ambrose || []).map((row) => Number(row.id))
      );
      const sultansTeamMembersById = await getSultansTeamMembersByTeamId(
        db,
        event.id,
        (visibleBoards.sultans || []).map((row) => Number(row.id))
      );

      return res.render('leaderboard/index', {
        title: `Leaderboards ${event.year}`,
        user: viewer,
        activeEvent: event,
        boards: visibleBoards,
        skinsLeaderboard,
        skinsCarryovers,
        championshipTable,
        playerMetaById,
        ambroseTeamMembersById,
        sultansTeamMembersById,
        dayStates,
        calcuttaSummary,
        activeView,
        leaderboardBasePath: `/leaderboards/event/${event.id}`,
        canManagePublish: false,
        hasDirtyMarker: false,
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
      const active = await db('events').where({ is_active: 1 }).first();
      if (!active) {
        const activeView = normalizeLeaderboardView(req.query.view);
        return res.render('leaderboard/index', {
          title: 'Leaderboards',
          user: viewer,
          activeEvent: null,
          boards: {
            ambrose: [],
            stableford: { byDay: { 2: [], 3: [], 4: [] }, championship: [] },
            eclectic: [],
            sultans: [],
            skins: { holes: [], winners: [], activePlayerCount: 0, stakePerPlayer: 1 }
          },
          skinsLeaderboard: { playerRows: [], teamRows: [] },
          skinsCarryovers: [],
          championshipTable: [],
          playerMetaById: {},
          ambroseTeamMembersById: {},
          sultansTeamMembersById: {},
          calcuttaSummary: {
            finalized: false,
            totalPlayers: 0,
            drawnPlayers: 0,
            missingOwnerCount: 0,
            poolTotal: 0,
            rows: [],
            balances: [],
            viewerBalance: null
          },
          dayStates: [],
          activeView,
          leaderboardBasePath: '/leaderboards',
          canManagePublish: false,
          hasDirtyMarker: false,
          message: req.query.message ? String(req.query.message) : null,
          error: req.query.error ? String(req.query.error) : null
        });
      }

      const [publicationRows, finalizationRows, calcuttaSummary] = await Promise.all([
        getDayPublicationRows(db, active.id),
        getDayFinalizationRows(db, active.id),
        getCalcuttaSummary(db, active.id, viewer?.id)
      ]);
      const requestedView = normalizeLeaderboardView(req.query.view);
      const activeView = requestedView === 'calcutta' && !calcuttaSummary.finalized
        ? 'championship'
        : requestedView;

      const dayStates = [1, 2, 3, 4].map((day) => {
        const pub = publicationRows.find((r) => r.day === day) || { day, status: 'draft', leaderboardPublished: false };
        const fin = finalizationRows.find((r) => r.day === day) || { day, total: 0, submitted: 0, isFinalized: false };
        return {
          day,
          label: dayLabel(day),
          status: pub.status,
          leaderboardPublished: pub.leaderboardPublished,
          total: fin.total,
          submitted: fin.submitted,
          isFinalized: fin.isFinalized
        };
      });

      const finalizedDays = dayStates.filter((d) => d.isFinalized).map((d) => d.day);
      const boards = await buildLeaderboards(db, active.id, { finalizedDaysForSkins: finalizedDays });
      const publishedDays = dayStates.filter((d) => d.leaderboardPublished).map((d) => d.day);
      const visibleDays = publishedDays;
      const visibleIndividualDays = visibleDays.filter((day) => [2, 3, 4].includes(day));
      const showAggregate = visibleIndividualDays.length > 0;
      const showEclectic = visibleIndividualDays.length >= 2;
      const showSultans = visibleIndividualDays.length >= 2;
      const skinsNormalized = normalizeSkins(boards.skins.holes, visibleDays);
      const championship =
        showAggregate
          ? buildChampionshipFromVisibleDays(boards.stableford?.byDay || {}, visibleIndividualDays)
          : [];
      const [eclecticTop, sultansTop] = showAggregate
        ? await Promise.all([
            showEclectic ? calculateEclecticLeaderboard(db, active.id, visibleIndividualDays) : Promise.resolve([]),
            showSultans ? calculateSultansLeaderboard(db, active.id, visibleIndividualDays) : Promise.resolve([])
          ])
        : [[], []];
      const visibleBoards = {
        ...boards,
        ambrose: visibleDays.includes(1) ? boards.ambrose : [],
        stableford: {
          byDay: {
            2: visibleDays.includes(2) ? (boards.stableford?.byDay?.[2] || []) : [],
            3: visibleDays.includes(3) ? (boards.stableford?.byDay?.[3] || []) : [],
            4: visibleDays.includes(4) ? (boards.stableford?.byDay?.[4] || []) : []
          },
          championship
        },
        eclectic: showEclectic ? eclecticTop : [],
        sultans: showSultans ? sultansTop : [],
        skins: {
          ...boards.skins,
          holes: skinsNormalized.holes,
          daily: skinsNormalized.daily
        }
      };
      const skinPotPerHole = Number(visibleBoards.skins.activePlayerCount || 0) * Number(active.skins_amount_per_player_per_hole || 1);
      const skinsLeaderboard = buildSkinsLeaderboard(visibleBoards.skins.holes, skinPotPerHole);
      const skinsCarryovers = buildSkinsCarryovers(visibleBoards.skins.holes);
      const championshipTable = buildChampionshipTable(visibleBoards.stableford);
      const calcuttaPayouts = buildCalcuttaPayouts(
        active,
        calcuttaSummary,
        visibleBoards.stableford?.byDay || {},
        championshipTable,
        publishedDays
      );
      if (calcuttaPayouts.enabled) {
        const viewerId = Number(viewer?.id || 0);
        const personalPayout = Number(calcuttaPayouts.personalPayoutByUserId.get(viewerId) || 0);
        if (calcuttaSummary.viewerBalance) {
          calcuttaSummary.viewerBalance.personalPayout = personalPayout;
          calcuttaSummary.viewerBalance.netAfterPayout = Number(calcuttaSummary.viewerBalance.netBalance || 0) + personalPayout;
        }
      }
      calcuttaSummary.payouts = calcuttaPayouts;
      const userIdsNeedingMeta = [
        ...championshipTable.map((row) => Number(row.userId)),
        ...(visibleBoards.eclectic || []).map((row) => Number(row.userId))
      ];
      const playerMetaById = await getPlayerMetaByUserIds(db, active.id, userIdsNeedingMeta);
      const ambroseTeamMembersById = await getAmbroseTeamMembersByTeamId(
        db,
        active.id,
        (visibleBoards.ambrose || []).map((row) => Number(row.id))
      );
      const sultansTeamMembersById = await getSultansTeamMembersByTeamId(
        db,
        active.id,
        (visibleBoards.sultans || []).map((row) => Number(row.id))
      );

      return res.render('leaderboard/index', {
        title: 'Leaderboards',
        user: viewer,
        activeEvent: active,
        boards: visibleBoards,
        skinsLeaderboard,
        skinsCarryovers,
        championshipTable,
        playerMetaById,
        ambroseTeamMembersById,
        sultansTeamMembersById,
        dayStates,
        calcuttaSummary,
        activeView,
        leaderboardBasePath: '/leaderboards',
        canManagePublish: false,
        hasDirtyMarker: false,
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
