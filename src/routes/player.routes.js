'use strict';

const crypto = require('crypto');
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { computeCourseHandicap } = require('../services/scoring/handicap.service');
const { calculateStablefordLeaderboards } = require('../services/scoring/stableford-leaderboard.service');
const { calculateEventSkinsForDays } = require('../services/scoring/skins.service');
const { dayLabel } = require('../services/events/day-label.service');
const { sanitizeCode } = require('../services/auth/login-code.service');
const { sendEmailChangeCode } = require('../services/auth/mailer.service');
const { LOGIN_CODE_EXPIRY_MINUTES, LOGIN_CODE_LENGTH, LOGIN_CODE_RESEND_SECONDS } = require('../config/constants');

function hashEmailCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateEmailCode() {
  return String(crypto.randomInt(0, 10 ** LOGIN_CODE_LENGTH)).padStart(LOGIN_CODE_LENGTH, '0');
}

function playerRouter(db) {
  const router = express.Router();

  // Resolves which active tour to show for the current tenant.
  // Returns { tour, needsPicker, tours } — if needsPicker is true, render the picker with `tours`.
  async function resolveActiveTour(tenantId, requestedTourId) {
    if (requestedTourId) {
      const tour = await db('tours')
        .where({ id: Number(requestedTourId), tenant_id: tenantId, status: 'active' })
        .first();
      // Invalid / not-active tourId → fall through to normal resolution
      if (tour) return { tour, needsPicker: false, tours: [] };
    }

    const tours = await db('tours')
      .where({ tenant_id: tenantId, status: 'active' })
      .orderBy('year', 'desc');

    if (tours.length <= 1) return { tour: tours[0] || null, needsPicker: false, tours: [] };

    // Multiple active tours — fetch date ranges so the picker can show them
    const dateRanges = await db('golf_rounds')
      .whereIn('tour_id', tours.map((t) => t.id))
      .groupBy('tour_id')
      .select('tour_id', db.raw('MIN(tour_date) as start_date'), db.raw('MAX(tour_date) as end_date'));

    const rangeByTourId = {};
    for (const r of dateRanges) rangeByTourId[r.tour_id] = r;

    const toursWithDates = tours.map((t) => ({
      ...t,
      start_date: rangeByTourId[t.id]?.start_date || null,
      end_date: rangeByTourId[t.id]?.end_date || null,
    }));

    return { tour: null, needsPicker: true, tours: toursWithDates };
  }

  router.get('/', requireAuth, (req, res) => {
    return res.redirect(res.locals.tenantPath('/dashboard'));
  });

  router.get('/dashboard', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.user;
      const tenant = req.tenant;

      const { tour: activeTour, needsPicker, tours } = await resolveActiveTour(tenant.id, req.query.tourId);

      if (needsPicker) {
        return res.render('player/tour-picker', { title: 'Your Tours', tours });
      }

      if (!activeTour) {
        const _now = new Date();
        return res.render('player/dashboard', {
          title: 'Dashboard',
          activeTour: null,
          openRound: null,
          todayGroup: null,
          todayHandicap: null,
          championshipStanding: null,
          skinsSummary: null,
          daysSummary: [],
          byDate: {},
          todayKey: _now.toISOString().slice(0, 10),
          tomorrowKey: new Date(_now.getTime() + 86400000).toISOString().slice(0, 10),
          tabOverride: null,
          dayLabel,
        });
      }

      const tourId = Number(activeTour.id);

      const allRoundRows = await db('golf_rounds')
        .where({ tour_id: tourId })
        .orderBy('round_number')
        .select('round_number', 'status', 'calc_type', 'course_id', 'female_course_id', 'leaderboard_published');

      const openRound = allRoundRows.find((r) => r.status === 'open') || null;

      let todayHandicap = null;
      if (openRound) {
        const [roundHcpRow, tourHcpRow] = await Promise.all([
          db('player_day_handicaps').where({ tour_id: tourId, round_number: openRound.round_number, user_id: user.id }).first(),
          db('player_handicaps').where({ tour_id: tourId, user_id: user.id }).first(),
        ]);
        const rawIndex = roundHcpRow
          ? Number(roundHcpRow.handicap_index)
          : tourHcpRow
          ? Number(tourHcpRow.playing_handicap)
          : null;

        if (rawIndex !== null) {
          const playerUser = await db('users').where({ id: user.id }).select('gender').first();
          const courseId = (playerUser?.gender === 'female' && openRound.female_course_id)
            ? openRound.female_course_id
            : openRound.course_id;
          if (courseId) {
            const [course, parRow] = await Promise.all([
              db('courses').where({ id: courseId }).first(),
              db('holes').where({ course_id: courseId }).sum('par as total').first(),
            ]);
            todayHandicap = computeCourseHandicap(rawIndex, course?.slope_rating, course?.course_rating, Number(parRow?.total) || 72);
          } else {
            todayHandicap = Math.round(rawIndex);
          }
        }
      }

      let todayGroup = null;
      if (openRound) {
        const myGroupRow = await db('tee_groups as tg')
          .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
          .where({ 'tg.tour_id': tourId, 'tg.round_number': openRound.round_number, 'tgp.user_id': user.id })
          .select('tg.id as groupId', 'tg.group_number', 'tg.tee_time', 'tg.starting_hole', 'tg.tee_location')
          .first();

        if (myGroupRow) {
          const [groupPlayers, scorecard] = await Promise.all([
            db('tee_group_players as tgp')
              .join('users as u', 'u.id', 'tgp.user_id')
              .where({ 'tgp.tee_group_id': myGroupRow.groupId })
              .orderBy('tgp.position')
              .select('u.id', 'u.first_name', 'u.last_name'),
            db('scorecards')
              .where({ tour_id: tourId, round_number: openRound.round_number, user_id: user.id, type: 'individual' })
              .first(),
          ]);

          todayGroup = {
            groupNumber: myGroupRow.group_number,
            teeTime: myGroupRow.tee_time ? String(myGroupRow.tee_time).slice(0, 5) : null,
            startingHole: myGroupRow.starting_hole,
            teeLocation: myGroupRow.tee_location,
            players: groupPlayers.map((p) => ({
              id: Number(p.id),
              name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
              isMe: Number(p.id) === Number(user.id),
            })),
            scorecard: scorecard || null,
          };
        }
      }

      const publishedRoundNumbers = allRoundRows
        .filter((r) => r.leaderboard_published)
        .map((r) => r.round_number);
      const stablefordRoundNumbers = allRoundRows
        .filter((r) => r.calc_type !== 'ambrose_nett')
        .map((r) => r.round_number);

      const publishedStablefordRounds = stablefordRoundNumbers.filter((rn) => publishedRoundNumbers.includes(rn));

      let championshipStanding = null;
      if (publishedStablefordRounds.length) {
        const boards = await calculateStablefordLeaderboards(db, tourId, {
          roundNumbers: publishedStablefordRounds,
          bestOf: activeTour.leaderboard_best_of_rounds || null
        });
        const championship = boards?.championship || [];
        const idx = championship.findIndex((row) => Number(row.userId) === Number(user.id));
        if (idx >= 0) {
          const row = championship[idx];
          const leaderPoints = Number(championship[0]?.total || championship[0]?.points || 0);
          championshipStanding = {
            place: idx + 1,
            total: championship.length,
            points: Number(row.total || row.points || 0),
            pointsFromLeader: Math.max(0, leaderPoints - Number(row.total || row.points || 0)),
          };
        }
      }

      let skinsSummary = null;
      if (activeTour.skins_enabled && publishedRoundNumbers.length) {
        const [activePlayerCountRow, skins] = await Promise.all([
          db('event_players').where({ tour_id: tourId, status: 'active' }).count({ total: '*' }).first(),
          calculateEventSkinsForDays(db, tourId, publishedRoundNumbers),
        ]);
        const baseSkinPot = Number(activePlayerCountRow?.total || 0) * Number(activeTour.skins_amount_per_player_per_hole || 0);
        const myWins = (skins?.holes || [])
          .filter((h) => h.status === 'won' && String(h.participant_type) === 'player' && Number(h.winning_participant_id) === Number(user.id))
          .map((h) => {
            const basePot = Number(h.base_pot_amount || 0);
            const skinsCount = basePot > 0 ? Math.round(Number(h.total_pot_amount || 0) / basePot) : 1;
            return { roundNumber: Number(h.round_number), holeNumber: Number(h.hole_number), skinsCount, payout: skinsCount * baseSkinPot };
          })
          .sort((a, b) => a.roundNumber - b.roundNumber || a.holeNumber - b.holeNumber);

        const totalSkins = myWins.reduce((s, h) => s + h.skinsCount, 0);
        if (totalSkins > 0) {
          skinsSummary = { totalSkins, totalPayout: totalSkins * baseSkinPot, baseSkinPot, wins: myWins };
        }
      }

      const daysSummary = await Promise.all(
        allRoundRows.map(async (roundRow) => {
          const [teeGroupRow, scorecard] = await Promise.all([
            db('tee_groups as tg')
              .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
              .where({ 'tg.tour_id': tourId, 'tg.round_number': roundRow.round_number, 'tgp.user_id': user.id })
              .select('tg.group_number', 'tg.tee_time', 'tg.starting_hole')
              .first(),
            db('scorecards')
              .where({ tour_id: tourId, round_number: roundRow.round_number, user_id: user.id, type: 'individual' })
              .first(),
          ]);
          return {
            roundNumber: roundRow.round_number,
            status: roundRow.status,
            leaderboardPublished: Boolean(roundRow.leaderboard_published),
            teeTime: teeGroupRow?.tee_time ? String(teeGroupRow.tee_time).slice(0, 5) : null,
            startingHole: teeGroupRow?.starting_hole || null,
            groupNumber: teeGroupRow?.group_number || null,
            scorecardId: scorecard ? Number(scorecard.id) : null,
            scorecardStatus: scorecard?.status || null,
          };
        })
      );

      const [itineraryItems, roundsForItinerary, teeTimeRows, myTeeGroupRows] = await Promise.all([
        db('itinerary_items').where({ tour_id: tourId }).orderBy(['item_date', 'sort_order', 'start_time']),
        db('golf_rounds as gr')
          .join('courses as c', 'gr.course_id', 'c.id')
          .where({ 'gr.tour_id': tourId })
          .orderBy('gr.round_number')
          .select('gr.round_number', 'gr.tour_date', 'gr.calc_type', 'gr.status', 'c.course_name', 'c.tee_name'),
        db('tee_groups')
          .where({ tour_id: tourId })
          .groupBy(['tour_id', 'round_number'])
          .select('round_number', db.raw('MIN(tee_time) as first_tee_time')),
        db('tee_groups as tg')
          .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
          .where({ 'tg.tour_id': tourId, 'tgp.user_id': user.id })
          .select('tg.id as group_id', 'tg.round_number', 'tg.tee_time', 'tg.starting_hole', 'tg.group_number'),
      ]);

      const myGroupIds = myTeeGroupRows.map((g) => g.group_id);
      const allGroupPlayers = myGroupIds.length
        ? await db('tee_group_players as tgp')
            .join('users as u', 'u.id', 'tgp.user_id')
            .whereIn('tgp.tee_group_id', myGroupIds)
            .orderBy('tgp.position')
            .select('tgp.tee_group_id', 'u.id', 'u.first_name', 'u.last_name')
        : [];

      const playersByGroup = {};
      for (const p of allGroupPlayers) {
        if (!playersByGroup[p.tee_group_id]) playersByGroup[p.tee_group_id] = [];
        playersByGroup[p.tee_group_id].push({
          id: Number(p.id),
          name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
          isMe: Number(p.id) === Number(user.id),
        });
      }

      const myGroupByRound = {};
      for (const g of myTeeGroupRows) {
        myGroupByRound[g.round_number] = {
          teeTime: g.tee_time ? String(g.tee_time).slice(0, 5) : null,
          startingHole: g.starting_hole,
          groupNumber: g.group_number,
          players: playersByGroup[g.group_id] || [],
        };
      }

      const itinTeeTimeByRound = {};
      for (const t of teeTimeRows) itinTeeTimeByRound[t.round_number] = t.first_tee_time;

      const byDate = {};

      for (const r of roundsForItinerary) {
        const key = String(r.tour_date).slice(0, 10);
        if (!byDate[key]) byDate[key] = [];
        byDate[key].push({
          _kind: 'round',
          round_number: r.round_number,
          course_name: r.course_name,
          tee_name: r.tee_name,
          calc_type: r.calc_type,
          status: r.status,
          first_tee_time: itinTeeTimeByRound[r.round_number] || null,
          _sort_time: itinTeeTimeByRound[r.round_number] || null,
          my_group: myGroupByRound[r.round_number] || null,
        });
      }

      for (const item of itineraryItems) {
        const checkinKey = String(item.item_date).slice(0, 10);
        if (!byDate[checkinKey]) byDate[checkinKey] = [];
        byDate[checkinKey].push({
          ...item,
          _kind: 'item',
          _display: item.type === 'accommodation' && item.end_date ? 'checkin' : null,
          _sort_time: item.start_time || null,
        });

        if (item.type === 'accommodation' && item.end_date) {
          const checkoutKey = String(item.end_date).slice(0, 10);
          if (checkoutKey !== checkinKey) {
            if (!byDate[checkoutKey]) byDate[checkoutKey] = [];
            byDate[checkoutKey].push({
              ...item,
              _kind: 'item',
              _display: 'checkout',
              _sort_time: item.end_time || null,
            });
          }
        }
      }

      for (const key of Object.keys(byDate)) {
        byDate[key].sort((a, b) => {
          const aNote = a._kind === 'item' && a.type === 'note';
          const bNote = b._kind === 'item' && b.type === 'note';
          if (aNote !== bNote) return aNote ? -1 : 1;
          if (!a._sort_time && !b._sort_time) return 0;
          if (!a._sort_time) return 1;
          if (!b._sort_time) return -1;
          return a._sort_time < b._sort_time ? -1 : a._sort_time > b._sort_time ? 1 : 0;
        });
      }

      const todayKey = new Date().toISOString().slice(0, 10);
      const tomorrowKey = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

      return res.render('player/dashboard', {
        title: 'Dashboard',
        activeTour,
        openRound,
        todayGroup,
        todayHandicap,
        championshipStanding,
        skinsSummary,
        daysSummary,
        byDate,
        todayKey,
        tomorrowKey,
        tabOverride: req.query.tab || null,
        dayLabel,
      });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/itinerary', requireAuth, async (req, res, next) => {
    try {
      // Fall back to the most recent draft tour if no active tour exists, so
      // admins can view/plan itinerary before the tour is approved and activated.
      let { tour: activeTour, needsPicker, tours } = await resolveActiveTour(req.tenant.id, req.query.tourId);

      if (!activeTour && !needsPicker) {
        activeTour = await db('tours')
          .where({ tenant_id: req.tenant.id, status: 'draft' })
          .orderBy('year', 'desc')
          .first() || null;
      }

      if (needsPicker) {
        return res.render('player/tour-picker', { title: 'Your Tours', tours });
      }

      if (!activeTour) return res.redirect(res.locals.tenantPath('/dashboard'));

      const tourId = Number(activeTour.id);

      const user = req.session.user;

      const [items, rounds, teeTimeRows, myTeeGroupRows] = await Promise.all([
        db('itinerary_items')
          .where({ tour_id: tourId })
          .where(function () { this.whereNull('user_id').orWhere({ user_id: user.id }); })
          .orderBy(['item_date', 'sort_order', 'start_time']),
        db('golf_rounds as gr')
          .join('courses as c', 'gr.course_id', 'c.id')
          .where({ 'gr.tour_id': tourId })
          .orderBy('gr.round_number')
          .select('gr.round_number', 'gr.tour_date', 'gr.calc_type', 'gr.status', 'c.course_name', 'c.tee_name'),
        db('tee_groups')
          .where({ tour_id: tourId })
          .groupBy(['tour_id', 'round_number'])
          .select('round_number', db.raw('MIN(tee_time) as first_tee_time')),
        db('tee_groups as tg')
          .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
          .where({ 'tg.tour_id': tourId, 'tgp.user_id': user.id })
          .select('tg.id as group_id', 'tg.round_number', 'tg.tee_time', 'tg.starting_hole', 'tg.group_number'),
      ]);

      const myGroupIds = myTeeGroupRows.map((g) => g.group_id);
      const allGroupPlayers = myGroupIds.length
        ? await db('tee_group_players as tgp')
            .join('users as u', 'u.id', 'tgp.user_id')
            .whereIn('tgp.tee_group_id', myGroupIds)
            .orderBy('tgp.position')
            .select('tgp.tee_group_id', 'u.id', 'u.first_name', 'u.last_name')
        : [];

      const playersByGroup = {};
      for (const p of allGroupPlayers) {
        if (!playersByGroup[p.tee_group_id]) playersByGroup[p.tee_group_id] = [];
        playersByGroup[p.tee_group_id].push({
          id: Number(p.id),
          name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
          isMe: Number(p.id) === Number(user.id),
        });
      }

      const myGroupByRound = {};
      for (const g of myTeeGroupRows) {
        myGroupByRound[g.round_number] = {
          teeTime: g.tee_time ? String(g.tee_time).slice(0, 5) : null,
          startingHole: g.starting_hole,
          groupNumber: g.group_number,
          players: playersByGroup[g.group_id] || [],
        };
      }

      const teeTimeByRound = {};
      for (const t of teeTimeRows) teeTimeByRound[t.round_number] = t.first_tee_time;

      const byDate = {};

      for (const r of rounds) {
        const key = String(r.tour_date).slice(0, 10);
        if (!byDate[key]) byDate[key] = [];
        const firstTeeTime = teeTimeByRound[r.round_number] || null;
        byDate[key].push({
          _kind: 'round',
          round_number: r.round_number,
          course_name: r.course_name,
          tee_name: r.tee_name,
          calc_type: r.calc_type,
          status: r.status,
          first_tee_time: firstTeeTime,
          _sort_time: firstTeeTime,
          my_group: myGroupByRound[r.round_number] || null,
        });
      }

      for (const item of items) {
        const checkinKey = String(item.item_date).slice(0, 10);
        if (!byDate[checkinKey]) byDate[checkinKey] = [];
        byDate[checkinKey].push({
          ...item,
          _kind: 'item',
          _display: item.type === 'accommodation' && item.end_date ? 'checkin' : null,
          _sort_time: item.start_time || null,
        });

        if (item.type === 'accommodation' && item.end_date) {
          const checkoutKey = String(item.end_date).slice(0, 10);
          if (checkoutKey !== checkinKey) {
            if (!byDate[checkoutKey]) byDate[checkoutKey] = [];
            byDate[checkoutKey].push({
              ...item,
              _kind: 'item',
              _display: 'checkout',
              _sort_time: item.end_time || null,
            });
          }
        }
      }

      for (const key of Object.keys(byDate)) {
        byDate[key].sort((a, b) => {
          const aNote = a._kind === 'item' && a.type === 'note';
          const bNote = b._kind === 'item' && b.type === 'note';
          if (aNote !== bNote) return aNote ? -1 : 1;
          if (!a._sort_time && !b._sort_time) return 0;
          if (!a._sort_time) return 1;
          if (!b._sort_time) return -1;
          return a._sort_time < b._sort_time ? -1 : a._sort_time > b._sort_time ? 1 : 0;
        });
      }

      res.render('player/itinerary', {
        title: `Itinerary — ${activeTour.label}`,
        tour: activeTour,
        byDate,
        canEditPersonal: true,
      });
    } catch (err) { next(err); }
  });

  // ── Profile ──────────────────────────────────────────────────────────────

  router.get('/profile', requireAuth, async (req, res, next) => {
    try {
      const profileUser = await db('users').where({ id: req.session.user.id }).first();
      res.render('player/profile', {
        title: 'My Profile',
        profileUser,
        saved: req.query.saved === '1',
        errors: [],
        showEmailChangeForm: false,
        emailChangeValue: '',
      });
    } catch (err) { next(err); }
  });

  router.post('/profile', requireAuth, async (req, res, next) => {
    try {
      const userId = Number(req.session.user.id);
      const firstName   = (req.body.firstName   || '').trim();
      const lastName    = (req.body.lastName    || '').trim();
      const phoneNumber = (req.body.phoneNumber || '').trim() || null;
      const gender      = ['male', 'female'].includes(req.body.gender) ? req.body.gender : 'male';

      const errors = [];
      if (!firstName && !lastName) errors.push('Please enter at least a first or last name.');

      if (phoneNumber) {
        const clash = await db('users').where({ phone_number: phoneNumber }).whereNot({ id: userId }).first();
        if (clash) errors.push('That phone number is already linked to another account.');
      }

      if (errors.length) {
        const profileUser = await db('users').where({ id: userId }).first();
        return res.render('player/profile', { title: 'My Profile', profileUser, saved: false, errors });
      }

      await db('users').where({ id: userId }).update({
        first_name:   firstName || null,
        last_name:    lastName  || null,
        phone_number: phoneNumber,
        gender,
        updated_at:   new Date(),
      });

      req.session.user.firstName = firstName;
      req.session.user.lastName  = lastName;

      res.redirect(res.locals.tenantPath('/profile') + '?saved=1');
    } catch (err) { next(err); }
  });

  router.post('/profile/request-email-change', requireAuth, async (req, res, next) => {
    try {
      const userId = Number(req.session.user.id);
      const newEmail = (req.body.newEmail || '').trim().toLowerCase();
      const tenantPath = res.locals.tenantPath;

      const errors = [];
      if (!newEmail || !newEmail.includes('@')) errors.push('Please enter a valid email address.');

      if (!errors.length) {
        const currentUser = await db('users').where({ id: userId }).first();

        if (currentUser.email.toLowerCase() === newEmail) {
          errors.push('That is already your current email address.');
        } else {
          // Throttle: if a code was issued within the last LOGIN_CODE_RESEND_SECONDS, block
          if (currentUser.pending_email_expires_at) {
            const expiresMs = new Date(currentUser.pending_email_expires_at).getTime();
            const issuedMs = expiresMs - LOGIN_CODE_EXPIRY_MINUTES * 60 * 1000;
            const elapsedSeconds = (Date.now() - issuedMs) / 1000;
            if (elapsedSeconds < LOGIN_CODE_RESEND_SECONDS) {
              const remaining = Math.ceil(LOGIN_CODE_RESEND_SECONDS - elapsedSeconds);
              errors.push(`Please wait ${remaining}s before requesting another code.`);
            }
          }
        }

        if (!errors.length) {
          const clash = await db('users').whereRaw('lower(email) = ?', [newEmail]).whereNot({ id: userId }).first();
          if (clash) errors.push('That email address is already linked to another account.');
        }
      }

      if (errors.length) {
        const profileUser = await db('users').where({ id: userId }).first();
        return res.render('player/profile', {
          title: 'My Profile', profileUser, saved: false, errors, showEmailChangeForm: true, emailChangeValue: newEmail,
        });
      }

      const code = generateEmailCode();
      const nonce = hashEmailCode(code);
      const expiresAt = new Date(Date.now() + LOGIN_CODE_EXPIRY_MINUTES * 60 * 1000);

      await db('users').where({ id: userId }).update({
        pending_email: newEmail,
        pending_email_nonce: nonce,
        pending_email_expires_at: expiresAt,
      });

      try {
        await sendEmailChangeCode(newEmail, code);
      } catch (sendErr) {
        console.error('[profile] email_change_send_failed', sendErr?.message);
      }

      res.redirect(tenantPath('/profile'));
    } catch (err) { next(err); }
  });

  router.post('/profile/verify-email-change', requireAuth, async (req, res, next) => {
    try {
      const userId = Number(req.session.user.id);
      const code = sanitizeCode(req.body.code);
      const tenantPath = res.locals.tenantPath;

      const currentUser = await db('users').where({ id: userId }).first();

      if (!currentUser.pending_email || !currentUser.pending_email_nonce) {
        return res.redirect(tenantPath('/profile'));
      }

      const errors = [];
      if (new Date(currentUser.pending_email_expires_at).getTime() < Date.now()) {
        errors.push('Verification code has expired. Please request a new one.');
      } else if (code.length !== LOGIN_CODE_LENGTH || hashEmailCode(code) !== currentUser.pending_email_nonce) {
        errors.push('Invalid verification code. Please try again.');
      }

      if (errors.length) {
        return res.render('player/profile', {
          title: 'My Profile', profileUser: currentUser, saved: false, errors,
          showEmailChangeForm: false, emailChangeValue: '',
        });
      }

      await db('users').where({ id: userId }).update({
        email: currentUser.pending_email,
        pending_email: null,
        pending_email_nonce: null,
        pending_email_expires_at: null,
        updated_at: new Date(),
      });

      req.session.user.email = currentUser.pending_email;

      res.redirect(tenantPath('/profile') + '?saved=1');
    } catch (err) { next(err); }
  });

  router.post('/profile/cancel-email-change', requireAuth, async (req, res, next) => {
    try {
      await db('users').where({ id: Number(req.session.user.id) }).update({
        pending_email: null,
        pending_email_nonce: null,
        pending_email_expires_at: null,
      });
      res.redirect(res.locals.tenantPath('/profile'));
    } catch (err) { next(err); }
  });

  // ── Personal itinerary item CRUD ──────────────────────────────────────────

  const PERSONAL_ITEM_TYPES = ['note', 'flight'];
  const toNull = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;

  function buildPersonalDetails(type, body) {
    if (type === 'flight') {
      return {
        airline: toNull(body.detail_airline),
        flight_number: toNull(body.detail_flight_number),
        departure_airport: toNull(body.detail_departure_airport),
        arrival_airport: toNull(body.detail_arrival_airport),
        terminal: toNull(body.detail_terminal),
        booking_ref: toNull(body.detail_booking_ref),
      };
    }
    return null;
  }

  async function getActiveTourId(db, tenantId) {
    const tour = await db('tours').where({ tenant_id: tenantId, status: 'active' }).orderBy('year', 'desc').first();
    return tour ? Number(tour.id) : null;
  }

  router.post('/itinerary/personal', requireAuth, async (req, res, next) => {
    try {
      const tourId = await getActiveTourId(db, req.tenant.id);
      if (!tourId) return res.redirect(res.locals.tenantPath('/dashboard'));

      const type = PERSONAL_ITEM_TYPES.includes(req.body.type) ? req.body.type : null;
      if (!type || !req.body.itemDate || !toNull(req.body.title)) {
        return res.redirect(res.locals.tenantPath('/dashboard') + '?tab=trip');
      }

      const details = buildPersonalDetails(type, req.body);
      await db('itinerary_items').insert({
        tour_id: tourId,
        user_id: Number(req.session.user.id),
        type,
        item_date: req.body.itemDate,
        end_date: type === 'flight' ? toNull(req.body.endDate) : null,
        title: req.body.title.trim(),
        description: toNull(req.body.description),
        location: toNull(req.body.location),
        start_time: toNull(req.body.startTime),
        end_time: toNull(req.body.endTime),
        details: details ? JSON.stringify(details) : null,
        sort_order: 0,
      });

      const back = req.body.redirectBack === 'itinerary'
        ? res.locals.tenantPath('/itinerary')
        : res.locals.tenantPath('/dashboard') + '?tab=trip';
      res.redirect(back);
    } catch (err) { next(err); }
  });

  router.post('/itinerary/personal/:itemId(\\d+)', requireAuth, async (req, res, next) => {
    try {
      const itemId = parseInt(req.params.itemId, 10);
      const userId = Number(req.session.user.id);

      const item = await db('itinerary_items').where({ id: itemId, user_id: userId }).first();
      if (!item) return res.status(404).send('Item not found');

      const type = PERSONAL_ITEM_TYPES.includes(req.body.type) ? req.body.type : item.type;
      if (!req.body.itemDate || !toNull(req.body.title)) {
        return res.redirect(res.locals.tenantPath('/dashboard') + '?tab=trip');
      }

      const details = buildPersonalDetails(type, req.body);
      await db('itinerary_items').where({ id: itemId }).update({
        type,
        item_date: req.body.itemDate,
        end_date: type === 'flight' ? toNull(req.body.endDate) : null,
        title: req.body.title.trim(),
        description: toNull(req.body.description),
        location: toNull(req.body.location),
        start_time: toNull(req.body.startTime),
        end_time: toNull(req.body.endTime),
        details: details ? JSON.stringify(details) : null,
      });

      const back = req.body.redirectBack === 'itinerary'
        ? res.locals.tenantPath('/itinerary')
        : res.locals.tenantPath('/dashboard') + '?tab=trip';
      res.redirect(back);
    } catch (err) { next(err); }
  });

  router.post('/itinerary/personal/:itemId(\\d+)/delete', requireAuth, async (req, res, next) => {
    try {
      const itemId = parseInt(req.params.itemId, 10);
      const userId = Number(req.session.user.id);
      await db('itinerary_items').where({ id: itemId, user_id: userId }).delete();
      const back = req.body.redirectBack === 'itinerary'
        ? res.locals.tenantPath('/itinerary')
        : res.locals.tenantPath('/dashboard') + '?tab=trip';
      res.redirect(back);
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { playerRouter };
