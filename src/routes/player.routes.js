'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ROLES } = require('../config/roles');
const { CALC_TYPES, defaultCalcTypeForDay } = require('../config/calc-types');
const { calculateAmbroseLeaderboard } = require('../services/scoring/ambrose.service');
const { calculateStablefordLeaderboards } = require('../services/scoring/stableford-leaderboard.service');
const { calculateSultansLeaderboard } = require('../services/scoring/sultans.service');
const { calculateEventSkinsForDays } = require('../services/scoring/skins.service');
const { dayLabel } = require('../services/events/day-label.service');

function ambroseAllowance(memberCount) {
  if (memberCount === 2) return 1 / 4;
  if (memberCount === 3) return 1 / 3;
  return 0;
}

function formatAmbroseValue(raw, allowance) {
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

  if (!numerator) return `${signPrefix}${whole}`;
  return `${signPrefix}${whole} ${numerator}/${denominator}`;
}

function toMoney(raw) {
  const num = Number(raw || 0);
  if (!Number.isFinite(num)) return 0;
  return num;
}

function compareChampionshipRows(a, b) {
  return (
    Number(b.points || 0) - Number(a.points || 0) ||
    Number(b.countbackLast9 || 0) - Number(a.countbackLast9 || 0) ||
    Number(b.countbackLast6 || 0) - Number(a.countbackLast6 || 0) ||
    Number(b.countbackLast3 || 0) - Number(a.countbackLast3 || 0) ||
    Number(b.countbackLast1 || 0) - Number(a.countbackLast1 || 0) ||
    String(a.name || '').localeCompare(String(b.name || ''))
  );
}

function playerRouter(db) {
  const router = express.Router();

  router.get('/dashboard', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== ROLES.PLAYER && user.role !== ROLES.SCORER && user.role !== ROLES.ADMIN) {
      return res.status(403).render('auth/forbidden', { title: 'Forbidden', user });
    }

    const individualScores = await db('scorecards as s')
      .leftJoin('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
      .leftJoin('event_day_statuses as eds', function joinDayStatus() {
        this.on('eds.event_id', '=', 's.event_id').andOn('eds.day', '=', 's.day');
      })
      .where('s.user_id', user.id)
      .andWhere('s.type', 'individual')
      .groupBy('s.id', 's.day', 's.status', 's.event_id', 'eds.calc_type', 'eds.status')
      .select('s.id', 's.day', 's.status', 's.event_id', 'eds.calc_type', { day_status: 'eds.status' })
      .sum({ totalGross: 'sh.gross_score' })
      .sum({ totalStableford: 'sh.stableford_points' })
      .orderBy('s.day', 'asc');

    const ambroseScores = await db('scorecards as s')
      .join('teams as t', 't.id', 's.team_id')
      .join('team_members as tm', 'tm.team_id', 't.id')
      .leftJoin('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
      .leftJoin('event_day_statuses as eds', function joinDayStatus() {
        this.on('eds.event_id', '=', 's.event_id').andOn('eds.day', '=', 's.day');
      })
      .where('tm.user_id', user.id)
      .andWhere('s.type', 'team')
      .groupBy('s.id', 's.day', 's.status', 's.event_id', 's.team_id', 't.name', 'eds.calc_type', 'eds.status')
      .select('s.id', 's.day', 's.status', 's.event_id', 's.team_id', 't.name as teamName', 'eds.calc_type', { day_status: 'eds.status' })
      .sum({ totalGross: 'sh.gross_score' })
      .orderBy('s.day', 'asc');

    const ambroseScorecardIds = ambroseScores.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
    const teamMemberRows = ambroseScorecardIds.length
      ? await db('scorecards as s')
          .join('team_members as tm', 'tm.team_id', 's.team_id')
          .leftJoin('player_handicaps as ph', function joinPh() {
            this.on('ph.user_id', '=', 'tm.user_id').andOn('ph.event_id', '=', 's.event_id');
          })
          .whereIn('s.id', ambroseScorecardIds)
          .select('s.id as scorecard_id', 'ph.playing_handicap')
      : [];
    const teamMembersByScorecard = new Map();
    for (const row of teamMemberRows) {
      const key = Number(row.scorecard_id);
      if (!teamMembersByScorecard.has(key)) teamMembersByScorecard.set(key, []);
      teamMembersByScorecard.get(key).push(Number(row.playing_handicap || 0));
    }

    const recentScores = [
      ...individualScores.map((row) => ({
        ...row,
        calcType: row.calc_type || defaultCalcTypeForDay(row.day),
        entryType: 'individual',
        entryLabel: 'Individual',
        resultDisplay: `${Number(row.totalStableford || 0)} pts`,
        showGross: String(row.calc_type || defaultCalcTypeForDay(row.day)) !== CALC_TYPES.STABLEFORD
      })),
      ...ambroseScores.map((row) => ({
        ...row,
        calcType: row.calc_type || defaultCalcTypeForDay(row.day),
        entryType: 'team',
        entryLabel: row.teamName ? `Ambrose - ${row.teamName}` : 'Ambrose',
        resultDisplay: (() => {
          const handicaps = teamMembersByScorecard.get(Number(row.id)) || [];
          const allowance = ambroseAllowance(handicaps.length);
          const teamHcpRaw = handicaps.reduce((sum, h) => sum + Number(h || 0), 0) * allowance;
          const gross = Number(row.totalGross || 0);
          const netRaw = gross - teamHcpRaw;
          return `Net ${formatAmbroseValue(netRaw, allowance)}`;
        })(),
        showGross: String(row.calc_type || defaultCalcTypeForDay(row.day)) !== CALC_TYPES.STABLEFORD
      }))
    ].sort((a, b) => Number(a.day || 0) - Number(b.day || 0) || String(a.entryType).localeCompare(String(b.entryType)));

    const profile = await db('users')
      .where({ id: user.id })
      .select('first_name', 'last_name', 'email', 'phone_number', 'is_previous_winner')
      .first();

    const activeEvent = await db('events')
      .where({ is_active: 1 })
      .orderBy('year', 'desc')
      .first();

    let calcuttaSummary = null;
    let noveltySummary = null;
    let prizeSummary = null;
    let championshipStanding = null;
    let skinsSummary = null;

    if (activeEvent) {
      const eventId = Number(activeEvent.id);
      const [activePlayerCountRow, calcuttaCountsRow] = await Promise.all([
        db('event_players')
          .where({ event_id: eventId, status: 'active' })
          .count({ total: '*' })
          .first(),
        db('calcutta_auctions')
          .where({ event_id: eventId })
          .count({ total: '*' })
          .sum({ missing_owner_count: db.raw("CASE WHEN owner_user_id IS NULL THEN 1 ELSE 0 END") })
          .first()
      ]);

      const activePlayerCount = Number(activePlayerCountRow?.total || 0);
      const calcuttaDrawnCount = Number(calcuttaCountsRow?.total || 0);
      const calcuttaMissingOwnerCount = Number(calcuttaCountsRow?.missing_owner_count || 0);
      const isCalcuttaFinalized = activePlayerCount > 0
        && calcuttaDrawnCount === activePlayerCount
        && calcuttaMissingOwnerCount === 0;

      if (isCalcuttaFinalized) {
        const [boughtRows, soldRows, purchasesOwedRow, ownershipReceivableRow, allSalesRows, publishedRoundsRows] = await Promise.all([
          db('calcutta_auctions as ca')
            .join('users as auctioned', 'auctioned.id', 'ca.auctioned_user_id')
            .leftJoin('users as owner', 'owner.id', 'ca.owner_user_id')
            .where({ 'ca.event_id': eventId, 'ca.buyer_user_id': user.id })
            .orderBy('ca.draw_order', 'asc')
            .select(
              'ca.draw_order',
              'ca.auction_bid_amount',
              'auctioned.first_name as auctioned_first_name',
              'auctioned.last_name as auctioned_last_name',
              'owner.first_name as owner_first_name',
              'owner.last_name as owner_last_name'
            ),
          db('calcutta_auctions as ca')
            .join('users as auctioned', 'auctioned.id', 'ca.auctioned_user_id')
            .join('users as buyer', 'buyer.id', 'ca.buyer_user_id')
            .where({ 'ca.event_id': eventId, 'ca.owner_user_id': user.id })
            .orderBy('ca.draw_order', 'asc')
            .select(
              'ca.draw_order',
              'ca.auction_bid_amount',
              'auctioned.first_name as auctioned_first_name',
              'auctioned.last_name as auctioned_last_name',
              'buyer.first_name as buyer_first_name',
              'buyer.last_name as buyer_last_name'
            ),
          db('calcutta_auctions')
            .where({ event_id: eventId, buyer_user_id: user.id })
            .sum({ total: 'auction_bid_amount' })
            .first(),
          db('calcutta_auctions')
            .where({ event_id: eventId, owner_user_id: user.id })
            .sum({ total: db.raw('auction_bid_amount * 0.5') })
            .first(),
          db('calcutta_auctions as ca')
            .join('users as auctioned', 'auctioned.id', 'ca.auctioned_user_id')
            .join('users as buyer', 'buyer.id', 'ca.buyer_user_id')
            .leftJoin('users as owner', 'owner.id', 'ca.owner_user_id')
            .where({ 'ca.event_id': eventId })
            .select(
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
            ),
          db('event_day_statuses')
            .where({ event_id: eventId, leaderboard_published: 1 })
            .whereIn('day', [2, 3, 4])
            .select('day')
        ]);

        const purchasesOwed = Number(purchasesOwedRow?.total || 0);
        const ownershipReceivable = Number(ownershipReceivableRow?.total || 0);
        const poolTotal = allSalesRows.reduce((sum, row) => sum + (Number(row.auction_bid_amount || 0) * 0.5), 0);
        const publishedRoundSet = new Set((publishedRoundsRows || []).map((row) => Number(row.day)));
        const payouts = [];
        const pushPayout = (category, basisUserId, basisName, recipientUserId, recipientName, percent) => {
          const pct = Number(percent || 0);
          if (!Number.isFinite(pct) || pct <= 0) return;
          if (!Number.isInteger(Number(recipientUserId)) || Number(recipientUserId) <= 0) return;
          const amount = poolTotal * (pct / 100);
          payouts.push({
            category: String(category || ''),
            basisName: String(basisName || '').trim() || '-',
            recipientName: String(recipientName || '').trim() || '-',
            recipientUserId: Number(recipientUserId),
            basisUserId: Number(basisUserId || 0),
            percent: pct,
            amount
          });
        };

        if (publishedRoundSet.has(4) && poolTotal > 0) {
          const saleByAuctionedUser = new Map();
          allSalesRows.forEach((row) => {
            saleByAuctionedUser.set(Number(row.auctioned_user_id), row);
          });

          const stablefordBoards = await calculateStablefordLeaderboards(db, eventId);
          [2, 3, 4].forEach((day) => {
            const dailyWinner = (stablefordBoards?.byDay?.[day] || [])[0];
            if (!dailyWinner) return;
            const sale = saleByAuctionedUser.get(Number(dailyWinner.userId || 0));
            if (!sale || !Number(sale.buyer_user_id || 0)) return;
            pushPayout(
              `Owner Daily Winner (${dayLabel(day)})`,
              Number(dailyWinner.userId || 0),
              `${sale.auctioned_first_name || ''} ${sale.auctioned_last_name || ''}`.trim(),
              Number(sale.buyer_user_id),
              `${sale.buyer_first_name || ''} ${sale.buyer_last_name || ''}`.trim(),
              Number(activeEvent.calcutta_owner_daily_winner_percent || 0)
            );
          });

          const champion = (stablefordBoards?.championship || [])[0];
          if (champion) {
            const championName = String(champion.name || '').trim();
            pushPayout(
              'Champion',
              Number(champion.userId || 0),
              championName,
              Number(champion.userId || 0),
              championName,
              Number(activeEvent.calcutta_champion_percent || 0)
            );

            const championSale = saleByAuctionedUser.get(Number(champion.userId || 0));
            if (championSale && Number(championSale.buyer_user_id || 0) > 0) {
              pushPayout(
                'Champion Owner',
                Number(champion.userId || 0),
                championName,
                Number(championSale.buyer_user_id),
                `${championSale.buyer_first_name || ''} ${championSale.buyer_last_name || ''}`.trim(),
                Number(activeEvent.calcutta_champion_owner_percent || 0)
              );
            }
          }

          const mysteryPlace = Number(activeEvent.calcutta_mystery_place || 0);
          if (mysteryPlace > 0) {
            const mysteryRow = (stablefordBoards?.championship || []).find((row) => Number(row.position || 0) === mysteryPlace);
            if (mysteryRow) {
              const mysterySale = saleByAuctionedUser.get(Number(mysteryRow.userId || 0));
              if (mysterySale && Number(mysterySale.buyer_user_id || 0) > 0) {
                pushPayout(
                  `Mystery Place #${mysteryPlace}`,
                  Number(mysteryRow.userId || 0),
                  `${mysterySale.auctioned_first_name || ''} ${mysterySale.auctioned_last_name || ''}`.trim(),
                  Number(mysterySale.buyer_user_id),
                  `${mysterySale.buyer_first_name || ''} ${mysterySale.buyer_last_name || ''}`.trim(),
                  Number(activeEvent.calcutta_mystery_place_percent || 0)
                );
              }
            }
          }
        }

        const payoutsForPlayer = payouts
          .filter((row) => Number(row.recipientUserId) === Number(user.id))
          .sort((a, b) => (
            String(a.category || '').localeCompare(String(b.category || '')) ||
            String(a.basisName || '').localeCompare(String(b.basisName || ''))
          ));
        const personalPayout = payoutsForPlayer
          .reduce((sum, row) => sum + Number(row.amount || 0), 0);
        calcuttaSummary = {
          event: activeEvent,
          boughtRows,
          soldRows,
          purchasesOwed,
          ownershipReceivable,
          netBalance: ownershipReceivable - purchasesOwed,
          personalPayout,
          netAfterPayout: (ownershipReceivable - purchasesOwed) + personalPayout,
          payoutsAvailable: payoutsForPlayer.length > 0,
          payouts: payoutsForPlayer
        };
      }

      const publishedNoveltyDayRow = await db('event_day_statuses as eds')
        .join('novelty_events as ne', function joinNoveltyEvents() {
          this.on('ne.event_id', '=', 'eds.event_id').andOn('ne.day', '=', 'eds.day');
        })
        .where({ 'eds.event_id': eventId, 'eds.leaderboard_published': 1 })
        .countDistinct({ total: 'eds.day' })
        .first();
      const publishedNoveltyDayCount = Number(publishedNoveltyDayRow?.total || 0);
      if (publishedNoveltyDayCount > 0) {
        const noveltyWinsRows = await db('novelty_results as nr')
          .join('novelty_events as ne', 'ne.id', 'nr.novelty_event_id')
          .join('event_day_statuses as eds', function joinDayStatus() {
            this.on('eds.event_id', '=', 'ne.event_id').andOn('eds.day', '=', 'ne.day');
          })
          .where({ 'nr.event_id': eventId, 'nr.winner_user_id': user.id })
          .andWhere('nr.is_no_winner', 0)
          .andWhere('eds.leaderboard_published', 1)
          .orderBy([{ column: 'ne.day', order: 'asc' }, { column: 'ne.hole_number', order: 'asc' }, { column: 'ne.id', order: 'asc' }])
          .select('ne.day', 'ne.hole_number', 'ne.novelty_type', 'ne.label');

        const ntpWins = noveltyWinsRows.filter((row) => String(row.novelty_type || '') === 'NTP').length;
        const longDriveWins = noveltyWinsRows.filter((row) => String(row.novelty_type || '') === 'Long Drive').length;
        noveltySummary = {
          event: activeEvent,
          wins: noveltyWinsRows,
          totalWins: noveltyWinsRows.length,
          ntpWins,
          longDriveWins
        };
      }

      const publishedDayRows = await db('event_day_statuses')
        .where({ event_id: eventId, leaderboard_published: 1 })
        .orderBy('day', 'asc')
        .select('day');
      const publishedDays = publishedDayRows.map((row) => Number(row.day)).filter((d) => d >= 1 && d <= 4);
      const publishedChampionshipDays = publishedDays.filter((d) => d >= 2 && d <= 4);

      if (publishedChampionshipDays.length) {
        const stablefordPublished = await calculateStablefordLeaderboards(db, eventId);
        const aggregateByUser = new Map();
        publishedChampionshipDays.forEach((day) => {
          (stablefordPublished?.byDay?.[day] || []).forEach((row) => {
            const userId = Number(row.userId || 0);
            if (!userId) return;
            if (!aggregateByUser.has(userId)) {
              aggregateByUser.set(userId, {
                userId,
                name: row.name,
                points: 0,
                countbackLast9: 0,
                countbackLast6: 0,
                countbackLast3: 0,
                countbackLast1: 0
              });
            }
            const current = aggregateByUser.get(userId);
            current.points += Number(row.total || 0);
            current.countbackLast9 += Number(row.countbackLast9 || 0);
            current.countbackLast6 += Number(row.countbackLast6 || 0);
            current.countbackLast3 += Number(row.countbackLast3 || 0);
            current.countbackLast1 += Number(row.countbackLast1 || 0);
          });
        });

        const leaderboard = [...aggregateByUser.values()].sort(compareChampionshipRows);
        const leaderPoints = leaderboard.length ? Number(leaderboard[0].points || 0) : 0;
        const playerRowIndex = leaderboard.findIndex((row) => Number(row.userId) === Number(user.id));
        if (playerRowIndex >= 0) {
          const playerRow = leaderboard[playerRowIndex];
          championshipStanding = {
            place: playerRowIndex + 1,
            points: Number(playerRow.points || 0),
            pointsFromLeader: Math.max(0, leaderPoints - Number(playerRow.points || 0))
          };
        }
      }

      if (publishedDays.length) {
        const [activePlayerCountRow, stableford, ambrose, sultans, skins] = await Promise.all([
          db('event_players').where({ event_id: eventId, status: 'active' }).count({ total: '*' }).first(),
          calculateStablefordLeaderboards(db, eventId),
          calculateAmbroseLeaderboard(db, eventId),
          calculateSultansLeaderboard(db, eventId),
          calculateEventSkinsForDays(db, eventId, publishedDays)
        ]);

        const activePlayerCount = Number(activePlayerCountRow?.total || 0);
        const skinsStake = toMoney(activeEvent.skins_amount_per_player_per_hole || 1);
        const baseSkinPot = activePlayerCount * skinsStake;
        const prizeConfig = {
          ambroseWinner: toMoney(activeEvent.prize_ambrose_winner_amount),
          ambroseSecond: toMoney(activeEvent.prize_ambrose_second_amount),
          dailyWinner: toMoney(activeEvent.prize_daily_winner_amount),
          dailySecond: toMoney(activeEvent.prize_daily_second_amount),
          sultansWinner: toMoney(activeEvent.prize_sultans_winner_amount),
          ntp: toMoney(activeEvent.prize_ntp_amount),
          longDrive: toMoney(activeEvent.prize_long_drive_amount)
        };

        const lineItems = [];
        const teamSplitItems = [];
        const addUserItem = (day, category, label, amount, winnerUserId) => {
          if (!amount || Number(amount) <= 0) return;
          if (Number(winnerUserId) !== Number(user.id)) return;
          lineItems.push({ day, category, label, amount: Number(amount) });
        };
        const addTeamItem = (day, category, label, amount, teamId) => {
          if (!amount || Number(amount) <= 0) return;
          if (!Number.isInteger(Number(teamId)) || Number(teamId) <= 0) return;
          teamSplitItems.push({ day, category, label, amount: Number(amount), teamId: Number(teamId) });
        };

        if (publishedDays.includes(1)) {
          const winner = (ambrose || [])[0];
          const second = (ambrose || [])[1];
          if (winner) addTeamItem(1, 'ambrose', 'Ambrose Winner', prizeConfig.ambroseWinner, Number(winner.id));
          if (second) addTeamItem(1, 'ambrose', 'Ambrose 2nd', prizeConfig.ambroseSecond, Number(second.id));
        }

        [2, 3, 4].forEach((day) => {
          if (!publishedDays.includes(day)) return;
          const rows = stableford?.byDay?.[day] || [];
          const winner = rows[0];
          const second = rows[1];
          if (winner) addUserItem(day, 'daily', 'Daily Winner', prizeConfig.dailyWinner, Number(winner.userId));
          if (second) addUserItem(day, 'daily', 'Daily 2nd', prizeConfig.dailySecond, Number(second.userId));
        });

        if (publishedDays.includes(4)) {
          const sultansWinner = (sultans || [])[0];
          if (sultansWinner) addTeamItem(4, 'sultans', 'Sultans Winner', prizeConfig.sultansWinner, Number(sultansWinner.id));
        }

        const noveltyPrizeRows = await db('novelty_results as nr')
          .join('novelty_events as ne', 'ne.id', 'nr.novelty_event_id')
          .join('event_day_statuses as eds', function joinDayStatus() {
            this.on('eds.event_id', '=', 'ne.event_id').andOn('eds.day', '=', 'ne.day');
          })
          .where({ 'nr.event_id': eventId, 'eds.leaderboard_published': 1 })
          .andWhere('nr.is_no_winner', 0)
          .whereIn('ne.day', publishedDays)
          .select('ne.day', 'ne.novelty_type', 'nr.winner_user_id');
        noveltyPrizeRows.forEach((row) => {
          const type = String(row.novelty_type || '');
          const amount = type === 'NTP' ? prizeConfig.ntp : prizeConfig.longDrive;
          const label = type === 'NTP' ? 'NTP Winner' : 'Long Drive Winner';
          addUserItem(Number(row.day), type === 'NTP' ? 'ntp' : 'long_drive', label, amount, Number(row.winner_user_id || 0));
        });

        (skins?.holes || [])
          .filter((hole) => publishedDays.includes(Number(hole.day)))
          .filter((hole) => String(hole.status || '') === 'won' && Number(hole.winning_participant_id || 0) > 0)
          .forEach((hole) => {
            const units = Number(hole.base_pot_amount || 0) > 0
              ? Math.round(Number(hole.total_pot_amount || 0) / Number(hole.base_pot_amount || 0))
              : 0;
            const amount = units * baseSkinPot;
            if (String(hole.participant_type) === 'team') {
              addTeamItem(Number(hole.day), 'skins', `Skins Hole ${Number(hole.hole_number || 0)}`, amount, Number(hole.winning_participant_id));
            } else {
              addUserItem(Number(hole.day), 'skins', `Skins Hole ${Number(hole.hole_number || 0)}`, amount, Number(hole.winning_participant_id));
            }
          });

        const personalSkinWins = (skins?.holes || [])
          .filter((hole) => publishedDays.includes(Number(hole.day)))
          .filter((hole) => String(hole.status || '') === 'won')
          .filter((hole) => String(hole.participant_type || '') === 'player')
          .filter((hole) => Number(hole.winning_participant_id || 0) === Number(user.id))
          .map((hole) => {
            const basePot = Number(hole.base_pot_amount || 0);
            const totalPot = Number(hole.total_pot_amount || 0);
            const skinsCount = basePot > 0 ? Math.max(0, Math.round(totalPot / basePot)) : 0;
            return {
              day: Number(hole.day || 0),
              holeNumber: Number(hole.hole_number || 0),
              gross: hole.winning_gross == null ? null : Number(hole.winning_gross),
              stableford: hole.winning_stableford == null ? null : Number(hole.winning_stableford),
              skinsCount
            };
          })
          .sort((a, b) => Number(a.day || 0) - Number(b.day || 0) || Number(a.holeNumber || 0) - Number(b.holeNumber || 0));
        if (publishedDays.length) {
          const totalSkins = personalSkinWins.reduce((sum, row) => sum + Number(row.skinsCount || 0), 0);
          skinsSummary = {
            event: activeEvent,
            baseSkinPot,
            totalSkins,
            totalPayout: totalSkins * baseSkinPot,
            wins: personalSkinWins
          };
        }

        if (teamSplitItems.length) {
          const teamIds = [...new Set(teamSplitItems.map((row) => Number(row.teamId)).filter((id) => id > 0))];
          const teamMembers = teamIds.length
            ? await db('team_members')
                .whereIn('team_id', teamIds)
                .select('team_id', 'user_id')
            : [];
          const membersByTeam = new Map();
          teamMembers.forEach((row) => {
            const key = Number(row.team_id);
            if (!membersByTeam.has(key)) membersByTeam.set(key, []);
            membersByTeam.get(key).push(Number(row.user_id));
          });
          teamSplitItems.forEach((item) => {
            const members = membersByTeam.get(Number(item.teamId)) || [];
            const share = members.length ? (Number(item.amount || 0) / members.length) : 0;
            if (!share) return;
            if (members.includes(Number(user.id))) {
              lineItems.push({
                day: item.day,
                category: item.category,
                label: `${item.label} (team share)`,
                amount: share
              });
            }
          });
        }

        if (lineItems.length) {
          const sortedItems = [...lineItems].sort((a, b) => Number(a.day || 0) - Number(b.day || 0) || String(a.label || '').localeCompare(String(b.label || '')));
          const totalWon = sortedItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
          const byCategory = sortedItems.reduce((acc, item) => {
            const key = String(item.category || 'other');
            acc[key] = Number(acc[key] || 0) + Number(item.amount || 0);
            return acc;
          }, {});
          prizeSummary = {
            event: activeEvent,
            totalWon,
            byCategory,
            items: sortedItems
          };
        }
      }
    }

    const openScorecards = recentScores
      .filter((score) => String(score.day_status || '') === 'open_scoring' && String(score.status || '') !== 'submitted')
      .sort((a, b) => Number(a.day || 0) - Number(b.day || 0))
      .map((score) => ({
        id: Number(score.id),
        day: Number(score.day || 0),
        label: score.entryLabel || 'Scorecard'
      }));

    return res.render('player/dashboard', {
      title: 'Player Dashboard',
      user,
      recentScores,
      openScorecards,
      profile,
      calcuttaSummary,
      noveltySummary,
      prizeSummary,
      championshipStanding,
      skinsSummary
    });
  });

  return router;
}

module.exports = { playerRouter };
