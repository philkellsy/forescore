'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireMinRole } = require('../middleware/authorize');
const { CALC_TYPES } = require('../config/calc-types');
const { golfCourseApiKey } = require('../config/env');
const { canActivate, canComplete } = require('../services/event-status.service');
const { computeCourseHandicap, strokesForHole, warmRoundCourseCache, invalidateRoundCourseCache } = require('../services/scoring/handicap.service');
const { groupSizes, distributeGroups, reverseLeaderboardGroups } = require('../services/scoring/group-generator.service');
const { findByEventDay: findNoveltyEvents, create: createNoveltyEvent, remove: removeNoveltyEvent, setResult: setNoveltyResult } = require('../db/repositories/novelty-events');
const { calculateStablefordLeaderboards } = require('../services/scoring/stableford-leaderboard.service');
const { calculateEventSkinsForDays } = require('../services/scoring/skins.service');
const { calculateVirtualTeamResults } = require('../services/scoring/virtual-teams.service');
const { dayLabel } = require('../services/events/day-label.service');
const { markLeaderboardDirty } = require('../services/leaderboard/dirty.service');
const virtualTeamsRepo = require('../db/repositories/virtual-teams');
const { sendWelcomeEmail } = require('../services/email/mailer');

// Test tenant bypasses tenant_id filter to access all courses system-wide.
function courseWhere(tenant, extra = {}) {
  if (tenant?.is_test_tenant) return extra;
  return { tenant_id: tenant?.id, ...extra };
}

const NOVELTY_TYPES = ['NTP', 'Long Drive', 'Other'];

const GOLF_API_BASE = 'https://api.golfcourseapi.com/v1';

async function golfApiGet(path) {
  const res = await fetch(`${GOLF_API_BASE}${path}`, {
    headers: { Authorization: `Key ${golfCourseApiKey}` },
  });
  if (!res.ok) throw new Error(`Golf API error: ${res.status}`);
  return res.json();
}

const CALC_TYPE_LABELS = {
  [CALC_TYPES.STABLEFORD]: 'Stableford',
  [CALC_TYPES.AMBROSE_NETT]: 'Ambrose Nett',
  stroke: 'Stroke Play',
};

async function ensureDayScorecards(db, tourId, roundNumber, calcType) {
  const playersInGroups = await db('tee_groups as tg')
    .join('tee_group_players as tgp', 'tgp.tee_group_id', 'tg.id')
    .where({ 'tg.tour_id': tourId, 'tg.round_number': roundNumber })
    .distinct('tgp.user_id');

  for (const row of playersInGroups) {
    const userId = Number(row.user_id);
    const existing = await db('scorecards')
      .where({ tour_id: tourId, round_number: roundNumber, type: 'individual', user_id: userId })
      .first();
    if (!existing) {
      await db('scorecards').insert({ tour_id: tourId, round_number: roundNumber, type: 'individual', user_id: userId, status: 'draft' }).returning('id');
    }
  }

  if (String(calcType || '') === CALC_TYPES.AMBROSE_NETT) {
    const teams = await db('teams')
      .where({ tour_id: tourId, round_number: roundNumber, competition_type: 'ambrose' })
      .select('id');

    for (const team of teams) {
      const existing = await db('scorecards')
        .where({ tour_id: tourId, round_number: roundNumber, type: 'team', team_id: team.id })
        .first();
      if (!existing) {
        await db('scorecards').insert({ tour_id: tourId, round_number: roundNumber, type: 'team', team_id: team.id, status: 'draft' }).returning('id');
      }
    }
  }

  // Auto-assign markers based on tee group position for each group.
  // Idempotent: only updates scorecards where marked_by_user_id IS NULL.
  const groups = await db('tee_groups').where({ tour_id: tourId, round_number: roundNumber }).select('id');
  for (const group of groups) {
    const groupSlots = await db('tee_group_players')
      .where({ tee_group_id: group.id })
      .select('user_id', 'position')
      .orderBy('position');
    if (groupSlots.length >= 2) {
      const sorted = [...groupSlots].sort((a, b) => Number(a.position) - Number(b.position));
      const n = sorted.length;
      const markerForIdx = n === 2 ? [1, 0] : n === 3 ? [2, 0, 1] : [1, 0, 3, 2];
      await db.transaction(async (trx) => {
        for (let i = 0; i < sorted.length; i++) {
          await trx('scorecards')
            .where({ tour_id: tourId, round_number: roundNumber, type: 'individual', user_id: Number(sorted[i].user_id) })
            .whereNull('marked_by_user_id')
            .update({ marked_by_user_id: Number(sorted[markerForIdx[i]].user_id), updated_at: trx.fn.now() });
        }
      });
    }
  }
}

function adminRouter(db) {
  const router = express.Router({ mergeParams: true });
  const guard = [requireAuth, requireMinRole('admin')];

  function isTenantAdmin(membership) {
    return membership?.role === 'admin' || membership?.role === 'owner';
  }

  function forbidden(res) {
    return res.status(403).render('auth/forbidden', { title: 'Forbidden', user: null, tenant: null });
  }

  // Passes for tenant admins/owners OR users with any tour_admins row in this tenant.
  async function requireDashboardAccess(req, res, next) {
    if (isTenantAdmin(req.tenantMembership)) return next();
    const row = await db('tour_admins as ta')
      .join('tours as t', 't.id', 'ta.tour_id')
      .where({ 't.tenant_id': req.tenant.id, 'ta.user_id': req.session.user.id })
      .first();
    if (row) return next();
    return forbidden(res);
  }

  // Passes for tenant admins/owners OR users in tour_admins for the specific :tourId.
  async function requireTourAccess(req, res, next) {
    if (isTenantAdmin(req.tenantMembership)) return next();
    const tourId = parseInt(req.params.tourId, 10);
    if (tourId) {
      const row = await db('tour_admins')
        .where({ tour_id: tourId, user_id: req.session.user.id })
        .first();
      if (row) return next();
    }
    return forbidden(res);
  }

  const tourGuard = [requireAuth, requireTourAccess];

  // Passes for any user who can access the admin area (tenant admin or any tour admin).
  // Used for shared resources like courses and player roster.
  const anyAdminGuard = [requireAuth, requireDashboardAccess];

  function requireSuperAdmin(req, res, next) {
    if (req.session?.user?.isSuperAdmin) return next();
    return forbidden(res);
  }

  const superAdminGuard = [requireAuth, requireSuperAdmin];

  // -------------------------------------------------------------------------
  // Dashboard — tour list
  // -------------------------------------------------------------------------
  router.get('/', [requireAuth, requireDashboardAccess], async (req, res, next) => {
    try {
      const tours = isTenantAdmin(req.tenantMembership)
        ? await db('tours').where({ tenant_id: req.tenant.id }).orderBy('year', 'desc')
        : await db('tours as t')
            .join('tour_admins as ta', 'ta.tour_id', 't.id')
            .where({ 't.tenant_id': req.tenant.id, 'ta.user_id': req.session.user.id })
            .orderBy('t.year', 'desc')
            .select('t.*');

      const actionable = tours.filter((t) => t.status === 'active' || t.status === 'draft');
      if (actionable.length === 1 && !req.query.list) {
        return res.redirect(res.locals.tenantPath(`/admin/tours/${actionable[0].id}`));
      }

      res.render('admin/dashboard', {
        title: 'Admin',
        user: req.session.user,
        tours,
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Create tour
  // -------------------------------------------------------------------------
  router.post('/tours', guard, async (req, res, next) => {
    try {
      const { label, year, location } = req.body;
      const validGenders = ['mens', 'womens', 'mixed'];
      const gender = validGenders.includes(req.body.gender) ? req.body.gender : 'mens';

      const [tour] = await db('tours').insert({
        tenant_id: req.tenant.id,
        label: String(label || '').trim(),
        year: parseInt(year, 10),
        location: String(location || '').trim(),
        status: 'draft',
        gender,
      }).returning('*');

      res.redirect(`${res.locals.tenantPath(`/admin/tours/${tour.id}`)}?message=Tour+created`);
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Tour detail — rounds overview + player roster
  // -------------------------------------------------------------------------
  router.get('/tours/:tourId', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const rounds = await db('golf_rounds').where({ tour_id: tourId }).orderBy('round_number');
      const roundByNumber = new Map(rounds.map((r) => [r.round_number, r]));
      const courses = await db('courses').where(courseWhere(req.tenant)).orderBy('course_name');
      const courseById = new Map(courses.map((c) => [c.id, c]));

      const tourPlayers = await db('event_players as ep')
        .join('users as u', 'u.id', 'ep.user_id')
        .join('tenant_memberships as m', function joinM() {
          this.on('m.user_id', '=', 'ep.user_id').andOnVal('m.tenant_id', '=', req.tenant.id);
        })
        .leftJoin('player_handicaps as ph', function joinPh() {
          this.on('ph.user_id', '=', 'ep.user_id').andOnVal('ph.tour_id', '=', tourId);
        })
        .where('ep.tour_id', tourId)
        .select('ep.*', 'u.first_name', 'u.last_name', 'u.email', 'u.phone_number', 'u.gender', 'ph.playing_handicap', 'm.role as member_role')
        .orderBy(['u.first_name', 'u.last_name']);

      const hasAnyScores = await db('scorecard_holes as sh')
        .join('scorecards as s', 's.id', 'sh.scorecard_id')
        .where('s.tour_id', tourId)
        .first();

      const tourAdmins = await db('tour_admins as ta')
        .join('users as u', 'u.id', 'ta.user_id')
        .where('ta.tour_id', tourId)
        .select('ta.id as ta_id', 'u.id as user_id', 'u.first_name', 'u.last_name', 'u.email')
        .orderBy(['u.first_name', 'u.last_name']);

      const tourAdminUserIds = tourAdmins.map((a) => a.user_id);
      const availableTourAdmins = await db('tenant_memberships as m')
        .join('users as u', 'u.id', 'm.user_id')
        .where('m.tenant_id', req.tenant.id)
        .whereNotIn('m.user_id', tourAdminUserIds.length ? tourAdminUserIds : [0])
        .whereNotIn('m.role', ['admin', 'owner'])
        .select('u.id', 'u.first_name', 'u.last_name', 'u.email')
        .orderBy(['u.first_name', 'u.last_name']);

      const virtualTeams = await virtualTeamsRepo.findByTour(db, tourId);

      const teeGroupCounts = await db('tee_groups')
        .where({ tour_id: tourId })
        .groupBy('round_number')
        .select('round_number', db.raw('count(*)::int as group_count'), db.raw('min(tee_time) as first_tee_time'));
      const teeCountByRound = new Map(teeGroupCounts.map((r) => [r.round_number, { count: r.group_count, firstTeeTime: r.first_tee_time }]));

      const roundRows = rounds.map((roundRow) => {
        const course = roundRow.course_id ? courseById.get(roundRow.course_id) : null;
        const teeInfo = teeCountByRound.get(roundRow.round_number) || { count: 0, firstTeeTime: null };
        return {
          roundNumber: roundRow.round_number,
          round: roundRow,
          course,
          date: roundRow.tour_date ? new Date(roundRow.tour_date) : null,
          teeGroupCount: teeInfo.count,
          firstTeeTime: teeInfo.firstTeeTime,
        };
      });

      res.render('admin/tour-detail', {
        title: tour.label,
        user: req.session.user,
        tour,
        rounds: roundRows,
        courses,
        tourPlayers,
        hasAnyScores: Boolean(hasAnyScores),
        tourAdmins,
        availableTourAdmins,
        virtualTeams,
        isTenantAdmin: isTenantAdmin(req.tenantMembership),
        calcTypeLabels: CALC_TYPE_LABELS,
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Update tour details
  // -------------------------------------------------------------------------
  router.post('/tours/:tourId', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const validGenders = ['mens', 'womens', 'mixed'];
      const gender = validGenders.includes(req.body.gender) ? req.body.gender : tour.gender;
      await db('tours').where({ id: tourId }).update({
        label: String(req.body.label || '').trim(),
        year: parseInt(req.body.year, 10),
        location: String(req.body.location || '').trim(),
        gender,
      });

      res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Tour+updated`);
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Activate tour (requires super admin payment approval)
  // -------------------------------------------------------------------------
  router.post('/tours/:tourId/activate', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const check = canActivate(tour);
      if (!check.ok) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?error=${encodeURIComponent(check.reason)}`);
      }

      await db('tours').where({ id: tourId }).update({ status: 'active' });
      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Tour+is+now+active`);
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Complete tour
  // -------------------------------------------------------------------------
  router.post('/tours/:tourId/complete', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const check = canComplete(tour);
      if (!check.ok) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?error=${encodeURIComponent(check.reason)}`);
      }

      await db('tours').where({ id: tourId }).update({ status: 'completed' });
      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Tour+marked+as+completed`);
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Tour setup — prizes, skins, leaderboard rules, novelties
  // -------------------------------------------------------------------------
  router.get('/tours/:tourId/setup', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const roundCount = await db('golf_rounds').where({ tour_id: tourId }).count('id as n').first();

      return res.render('admin/tour-setup', {
        title: `Setup — ${tour.label}`,
        user: req.session.user,
        tour,
        roundCount: Number(roundCount?.n || 0),
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/setup', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const b = req.body;
      const bestOf = parseInt(b.leaderboard_best_of_rounds, 10);

      const parsePrizes = (labelKey, amountKey) => {
        const labels = [].concat(b[labelKey] || []);
        const amounts = [].concat(b[amountKey] || []);
        return labels
          .map((label, i) => ({ label: String(label).trim(), amount: parseFloat(amounts[i]) || 0 }))
          .filter((p) => p.label);
      };

      await db('tours').where({ id: tourId }).update({
        leaderboard_best_of_rounds: Number.isFinite(bestOf) && bestOf > 0 ? bestOf : null,
        leaderboard_last_round_required: Boolean(b.leaderboard_last_round_required),
        skins_enabled: Boolean(b.skins_enabled),
        skins_amount_per_player_per_hole: parseFloat(b.skins_amount_per_player_per_hole) || 0,
        skins_carry_in_skins: Math.max(0, Math.trunc(parseFloat(b.skins_carry_in_skins) || 0)) || null,
        tour_prizes: JSON.stringify(parsePrizes('tour_prize_label', 'tour_prize_amount')),
        daily_prizes: JSON.stringify(parsePrizes('daily_prize_label', 'daily_prize_amount')),
        prize_ntp_amount: parseFloat(b.prize_ntp_amount) || 0,
        prize_long_drive_amount: parseFloat(b.prize_long_drive_amount) || 0,
      });

      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/setup`)}?message=Setup+saved`);
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Round config — GET
  // -------------------------------------------------------------------------
  router.get('/tours/:tourId/rounds/:roundNumber', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      let roundNumber = parseInt(req.params.roundNumber, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      if (!roundNumber || roundNumber < 1) {
        const existing = await db('golf_rounds').where({ tour_id: tourId }).max('round_number as max').first();
        roundNumber = (Number(existing?.max) || 0) + 1;
        return res.redirect(res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`));
      }

      const allCourses = await db('courses').where(courseWhere(req.tenant)).orderBy('course_name');
      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first() || null;
      const noveltyEvents = round ? await findNoveltyEvents(db, tourId, roundNumber) : [];

      const noveltyResultsByEventId = {};
      for (const ne of noveltyEvents) {
        const result = await db('novelty_results').where({ novelty_event_id: ne.id }).first() || null;
        if (result && result.winner_user_id) {
          const winner = await db('users').where({ id: result.winner_user_id }).select('first_name', 'last_name').first();
          result.winnerName = winner ? `${winner.first_name || ''} ${winner.last_name || ''}`.trim() : null;
        }
        noveltyResultsByEventId[ne.id] = result;
      }

      const noveltyPlayers = await db('event_players as ep')
        .join('users as u', 'u.id', 'ep.user_id')
        .where({ 'ep.tour_id': tourId, 'ep.status': 'active' })
        .orderBy(['u.last_name', 'u.first_name'])
        .select('ep.user_id', 'u.first_name', 'u.last_name');

      const mensCourses = allCourses.filter((c) => c.gender === 'mens' || c.gender === 'open');
      const womensCourses = allCourses.filter((c) => c.gender === 'womens' || c.gender === 'open');

      res.render('admin/round-config', {
        title: `Round ${roundNumber} — ${tour.label}`,
        user: req.session.user,
        tour,
        roundNumber,
        round,
        noveltyEvents,
        noveltyResultsByEventId,
        noveltyPlayers,
        mensCourses,
        womensCourses,
        calcTypes: Object.entries(CALC_TYPE_LABELS),
        isTestTenant: Boolean(req.tenant?.is_test_tenant),
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Round results — presentation report (day board + skins + championship)
  // -------------------------------------------------------------------------
  router.get('/tours/:tourId/rounds/:roundNumber/results', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const roundNumber = parseInt(req.params.roundNumber, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
      if (!round) return res.redirect(res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}?error=Round+not+configured`));

      // All rounds for this tour, ordered
      const allRoundRows = await db('golf_rounds')
        .where({ tour_id: tourId })
        .orderBy('round_number')
        .select('round_number', 'calc_type', 'status');

      const stablefordRoundNumbers = allRoundRows
        .filter((r) => r.calc_type !== 'ambrose_nett')
        .map((r) => Number(r.round_number));

      // Rounds up to and including this one (for championship + skins context)
      const roundsThrough = stablefordRoundNumbers.filter((rn) => rn <= roundNumber);

      // --- Day board ---
      const isAmbrose = round.calc_type === 'ambrose_nett';
      let dayBoard = [];
      let championship = [];
      let championshipRounds = [];

      if (isAmbrose) {
        // Ambrose: query teams scoped to this round
        const teamRows = await db('teams as t')
          .leftJoin('scorecards as s', function joinS() {
            this.on('s.team_id', '=', 't.id').andOnVal('s.round_number', '=', roundNumber);
          })
          .leftJoin('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
          .where({ 't.tour_id': tourId, 't.competition_type': 'ambrose', 't.round_number': roundNumber })
          .groupBy('t.id', 't.name')
          .select('t.id', 't.name')
          .sum({ totalGross: 'sh.gross_score' });

        const teamIds = teamRows.map((r) => r.id);
        const memberRows = teamIds.length
          ? await db('team_members as tm')
              .leftJoin('player_handicaps as ph', function joinPh() {
                this.on('ph.user_id', '=', 'tm.user_id').andOnVal('ph.tour_id', '=', tourId);
              })
              .whereIn('tm.team_id', teamIds)
              .select('tm.team_id', 'ph.playing_handicap')
          : [];

        const ambroseAllowance = (n) => (n === 2 ? 1 / 4 : n === 3 ? 1 / 3 : 0);
        dayBoard = teamRows.map((r) => {
          const members = memberRows.filter((m) => Number(m.team_id) === Number(r.id));
          const totalHcp = members.reduce((sum, m) => sum + Number(m.playing_handicap || 0), 0);
          const handicap = Math.trunc(totalHcp * ambroseAllowance(members.length));
          const gross = Number(r.totalGross || 0);
          return { id: r.id, name: r.name, gross, handicap, total: gross - handicap };
        }).sort((a, b) => a.total - b.total).map((r, i) => ({ ...r, position: i + 1 }));
      } else {
        // Single query covers both the day board and championship standings
        const lb = await calculateStablefordLeaderboards(db, tourId, {
          roundNumbers: roundsThrough.length ? roundsThrough : [roundNumber],
          bestOf: tour.leaderboard_best_of_rounds || null,
          lastRoundRequired: tour.leaderboard_last_round_required || false,
        });
        dayBoard = (lb.byDay[roundNumber] || []).map((r, i) => ({ ...r, position: i + 1 }));

        // --- Championship standings ---
        if (roundsThrough.length) {
          const roundMaps = {};
          roundsThrough.forEach((rn) => {
            roundMaps[rn] = new Map((lb.byDay[rn] || []).map((row) => [Number(row.userId), Number(row.total || 0)]));
          });
          championship = lb.championship.map((row) => ({
            ...row,
            rounds: Object.fromEntries(roundsThrough.map((rn) => [rn, roundMaps[rn].get(Number(row.userId)) ?? null])),
            droppedRounds: row.droppedRounds ? [...row.droppedRounds] : [],
          }));
          championshipRounds = roundsThrough;
        }
      }

      // --- Skins for this round ---
      let skinsHoles = [];
      let skinsWinners = [];
      let skinsCarryIn = 0;
      let skinsCarryOut = 0;
      const initialCarryInSkins = Number(tour.skins_carry_in_skins || 0);

      if (!isAmbrose && roundsThrough.length) {
        const skinsResult = await calculateEventSkinsForDays(db, tourId, roundsThrough, { initialCarryInSkins });
        const basePot = skinsResult.activePlayerCount; // 1 skin = basePot value
        const stakePerPlayer = Number(tour.skins_amount_per_player_per_hole || 0);
        const roundHoles = skinsResult.holes.filter((h) => Number(h.round_number) === roundNumber);

        if (roundHoles.length && basePot > 0) {
          skinsCarryIn = Math.round(Number(roundHoles[0].carry_in_amount || 0) / basePot);
          const lastHole = roundHoles[roundHoles.length - 1];
          if (lastHole.status === 'jackpot') {
            skinsCarryOut = Math.round(Number(lastHole.total_pot_amount || 0) / basePot);
          }
          skinsHoles = roundHoles.map((h) => ({
            holeNumber: Number(h.hole_number),
            carryIn: Math.round(Number(h.carry_in_amount || 0) / basePot),
            skinsAtStake: Math.round(Number(h.total_pot_amount || 0) / basePot),
            dollarAmount: h.status === 'won' && stakePerPlayer > 0
              ? Math.round(Number(h.total_pot_amount || 0) * stakePerPlayer)
              : 0,
            status: h.status,
            winnerName: h.winner_name || null,
            winningGross: h.winning_gross != null ? Number(h.winning_gross) : null,
            winningStableford: h.winning_stableford != null ? Number(h.winning_stableford) : null,
            tiedCount: Number(h.tied_count || 0),
            topStableford: Number(h.top_stableford || 0),
          }));

          // Aggregate winners for this round
          const wMap = new Map();
          for (const h of skinsHoles) {
            if (h.status !== 'won' || !h.winnerName) continue;
            if (!wMap.has(h.winnerName)) wMap.set(h.winnerName, { name: h.winnerName, skinsWon: 0, dollarWon: 0 });
            wMap.get(h.winnerName).skinsWon += h.skinsAtStake;
            wMap.get(h.winnerName).dollarWon += h.dollarAmount;
          }
          skinsWinners = [...wMap.values()].sort((a, b) => b.skinsWon - a.skinsWon);
        }
      }

      // --- Prizes ---
      const rawPrizes = isAmbrose ? (round.ambrose_prizes || '[]') : (tour.daily_prizes || '[]');
      const prizes = Array.isArray(rawPrizes) ? rawPrizes : JSON.parse(rawPrizes);

      // --- Virtual teams ---
      const virtualTeamResults = round && round.virtual_teams_enabled
        ? await calculateVirtualTeamResults(db, tourId, roundNumber)
        : [];

      // --- Scoring status (individual rounds only) ---
      let scoringStatus = [];
      if (!isAmbrose && round.course_id) {
        const statusCourse = await db('courses').where({ id: round.course_id }).first();
        const totalHoles = statusCourse
          ? Number((await db('holes').where({ course_id: statusCourse.id }).count('id as n').first()).n)
          : 18;

        const statusRows = await db('scorecards as s')
          .join('users as u', 'u.id', 's.user_id')
          .leftJoin('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
          .where({ 's.tour_id': tourId, 's.round_number': roundNumber, 's.type': 'individual' })
          .whereNotNull('s.user_id')
          .groupBy('s.id', 's.status', 's.user_id', 'u.first_name', 'u.last_name')
          .orderByRaw('u.last_name, u.first_name')
          .select('s.id as scorecardId', 's.status', 'u.first_name', 'u.last_name')
          .count('sh.hole_number as holesScored')
          .sum('sh.stableford_points as stablefordTotal');

        scoringStatus = statusRows.map((r) => {
          const holesScored = Number(r.holesScored || 0);
          const stablefordTotal = Number(r.stablefordTotal || 0);
          let state;
          if (r.status === 'submitted') state = 'submitted';
          else if (holesScored >= totalHoles) state = 'pending';
          else if (holesScored > 0) state = 'incomplete';
          else state = 'awaiting';
          return {
            name: `${r.first_name} ${r.last_name}`.trim(),
            scorecardId: Number(r.scorecardId),
            status: r.status,
            state,
            holesScored,
            totalHoles,
            stablefordTotal,
          };
        });
      }

      res.render('admin/round-results', {
        title: `${dayLabel(roundNumber)} Results — ${tour.label}`,
        user: req.session.user,
        tour,
        round,
        roundNumber,
        isAmbrose,
        dayBoard,
        prizes,
        championship,
        championshipRounds,
        skinsHoles,
        skinsWinners,
        skinsCarryIn,
        skinsCarryOut,
        virtualTeamResults,
        scoringStatus,
        dayLabel,
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Round scores — admin list + individual scorecard view
  // -------------------------------------------------------------------------
  router.get('/tours/:tourId/rounds/:roundNumber/scores', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const roundNumber = parseInt(req.params.roundNumber, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
      const allRoundNumbers = (await db('golf_rounds').where({ tour_id: tourId }).orderBy('round_number').select('round_number')).map((r) => r.round_number);

      const scorecards = await db('scorecards as s')
        .join('users as u', 'u.id', 's.user_id')
        .where({ 's.tour_id': tourId, 's.round_number': roundNumber, 's.type': 'individual' })
        .whereNotNull('s.user_id')
        .select('s.id', 's.user_id', 's.status', 'u.first_name', 'u.last_name')
        .orderBy(['u.last_name', 'u.first_name']);

      const totalsRows = await db('scorecard_holes as sh')
        .join('scorecards as sc', 'sc.id', 'sh.scorecard_id')
        .where({ 'sc.tour_id': tourId, 'sc.round_number': roundNumber, 'sc.type': 'individual' })
        .whereNotNull('sc.user_id')
        .select('sc.user_id')
        .sum('sh.gross_score as gross_total')
        .sum('sh.stableford_points as stableford_total')
        .count('sh.id as holes_entered')
        .groupBy('sc.user_id');

      const totalsMap = new Map(totalsRows.map((r) => [Number(r.user_id), {
        gross: Number(r.gross_total || 0),
        stableford: Number(r.stableford_total || 0),
        holesEntered: Number(r.holes_entered || 0),
      }]));

      const rows = scorecards.map((sc) => ({
        userId: Number(sc.user_id),
        name: `${sc.first_name || ''} ${sc.last_name || ''}`.trim(),
        status: sc.status,
        ...( totalsMap.get(Number(sc.user_id)) || { gross: 0, stableford: 0, holesEntered: 0 }),
      })).sort((a, b) => b.stableford - a.stableford || a.name.localeCompare(b.name));

      return res.render('admin/round-scores', {
        title: `Round ${roundNumber} Scores — ${tour.label}`,
        user: req.session.user,
        tour,
        round,
        roundNumber,
        allRoundNumbers,
        rows,
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { return next(err); }
  });

  router.get('/tours/:tourId/rounds/:roundNumber/scores/:userId', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const roundNumber = parseInt(req.params.roundNumber, 10);
      const userId = parseInt(req.params.userId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const [scorecard, player, holeConfig, holeScores, round] = await Promise.all([
        db('scorecards').where({ tour_id: tourId, round_number: roundNumber, type: 'individual', user_id: userId }).first(),
        db('users').where({ id: userId }).first(),
        db('golf_rounds as gr').join('holes as h', 'h.course_id', 'gr.course_id')
          .where({ 'gr.tour_id': tourId, 'gr.round_number': roundNumber })
          .orderBy('h.hole_number').select('h.hole_number', 'h.par', 'h.stroke_index_primary', 'h.stroke_index_secondary'),
        db('scorecard_holes as sh').join('scorecards as sc', 'sc.id', 'sh.scorecard_id')
          .where({ 'sc.tour_id': tourId, 'sc.round_number': roundNumber, 'sc.type': 'individual', 'sc.user_id': userId })
          .select('sh.hole_number', 'sh.gross_score', 'sh.stableford_points'),
        db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first(),
      ]);

      if (!scorecard || !player) return res.status(404).send('Scorecard not found');

      const hcpRow = await db('player_handicaps').where({ tour_id: tourId, user_id: userId }).first();
      const courseHcp = Math.trunc(Number(hcpRow?.playing_handicap || 0));
      const byHole = new Map(holeScores.map((r) => [Number(r.hole_number), r]));

      const holes = holeConfig.map((h) => {
        const saved = byHole.get(Number(h.hole_number));
        const gross = saved ? Number(saved.gross_score) : null;
        const shots = strokesForHole(courseHcp, Number(h.stroke_index_primary), Number(h.stroke_index_secondary));
        return {
          holeNumber: Number(h.hole_number), par: Number(h.par || 0),
          siPrimary: Number(h.stroke_index_primary || 0),
          gross, net: gross == null ? null : gross - shots,
          stableford: saved?.stableford_points != null ? Number(saved.stableford_points) : null,
        };
      });

      const valid = holes.filter((h) => h.gross != null);
      const sum = (arr, k) => arr.reduce((a, r) => a + Number(r[k] || 0), 0);
      const front = valid.filter((h) => h.holeNumber <= 9);
      const back = valid.filter((h) => h.holeNumber >= 10);
      const totals = { grossFront: sum(front, 'gross'), grossBack: sum(back, 'gross'), grossTotal: sum(valid, 'gross'), netFront: sum(front, 'net'), netBack: sum(back, 'net'), netTotal: sum(valid, 'net'), stablefordFront: sum(front, 'stableford'), stablefordBack: sum(back, 'stableford'), stablefordTotal: sum(valid, 'stableford') };
      const calcType = String(round?.calc_type || 'stableford');

      const model = {
        mode: 'individual', roundNumber, roundLabel: `Round ${roundNumber}`, dayLabel: `Round ${roundNumber}`, calcType,
        showStablefordTotals: calcType === 'stableford', showGrossOnlyTotals: calcType !== 'stableford',
        title: `${player.first_name || ''} ${player.last_name || ''}`.trim(),
        subtitle: `Hcp ${courseHcp}`,
        resultLabel: calcType === 'stableford' ? `${totals.stablefordTotal} pts` : `${totals.grossTotal} gross`,
        totals, holes,
        front9: holes.filter((h) => h.holeNumber >= 1 && h.holeNumber <= 9).sort((a, b) => a.holeNumber - b.holeNumber),
        back9: holes.filter((h) => h.holeNumber >= 10 && h.holeNumber <= 18).sort((a, b) => a.holeNumber - b.holeNumber),
      };

      const editLogs = await db('scorecard_edit_logs as sel')
        .leftJoin('users as u', 'u.id', 'sel.editor_user_id')
        .where({ 'sel.scorecard_id': scorecard.id })
        .orderBy([{ column: 'sel.created_at', order: 'desc' }, { column: 'sel.id', order: 'desc' }])
        .select('sel.hole_number', 'sel.previous_gross_score', 'sel.previous_stableford_points', 'sel.new_gross_score', 'sel.new_stableford_points', 'sel.created_at', 'u.first_name', 'u.last_name');

      const canEdit = round && !round.leaderboard_published;

      return res.render('admin/scorecard-review', {
        title: `${model.title} — Round ${roundNumber}`,
        user: req.session.user,
        tour,
        round,
        roundNumber,
        userId,
        scorecardId: scorecard.id,
        model,
        canEdit,
        editLogs,
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/rounds/:roundNumber/scores/:userId/holes/:holeNumber', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const roundNumber = parseInt(req.params.roundNumber, 10);
      const userId = parseInt(req.params.userId, 10);
      const holeNumber = parseInt(req.params.holeNumber, 10);
      const tp = res.locals.tenantPath;
      const returnUrl = tp(`/admin/tours/${tourId}/rounds/${roundNumber}/scores/${userId}`);

      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
      if (!round) return res.status(404).send('Round not found');
      if (round.leaderboard_published) {
        return res.redirect(`${returnUrl}?error=Unpublish+this+round+before+editing+scores`);
      }

      const scorecard = await db('scorecards').where({ tour_id: tourId, round_number: roundNumber, type: 'individual', user_id: userId }).first();
      if (!scorecard) return res.status(404).send('Scorecard not found');

      if (!Number.isInteger(holeNumber) || holeNumber < 1 || holeNumber > 18) {
        return res.redirect(`${returnUrl}?error=Invalid+hole+number`);
      }

      const hole = await db('holes as h')
        .join('golf_rounds as gr', 'gr.course_id', 'h.course_id')
        .where({ 'gr.tour_id': tourId, 'gr.round_number': roundNumber, 'h.hole_number': holeNumber })
        .select('h.par', 'h.stroke_index_primary', 'h.stroke_index_secondary')
        .first();
      if (!hole) return res.redirect(`${returnUrl}?error=Hole+configuration+not+found`);

      const hcpRow = await db('player_handicaps').where({ tour_id: tourId, user_id: userId }).first();
      const courseHcp = Math.trunc(Number(hcpRow?.playing_handicap || 0));

      const existing = await db('scorecard_holes').where({ scorecard_id: scorecard.id, hole_number: holeNumber }).first();
      const prevGross = existing ? Number(existing.gross_score) : null;
      const prevStableford = existing ? Number(existing.stableford_points) : null;

      const grossInput = String(req.body.grossScore || '').trim();

      if (grossInput === '') {
        if (existing) {
          await db('scorecard_holes').where({ id: existing.id }).delete();
          await db('scorecard_edit_logs').insert({ scorecard_id: scorecard.id, hole_number: holeNumber, previous_gross_score: prevGross, previous_stableford_points: prevStableford, new_gross_score: null, new_stableford_points: null, editor_user_id: req.session.user.id });
          await db('tours').where({ id: tourId }).update({ leaderboard_dirty_at: db.fn.now() });
        }
        return res.redirect(`${returnUrl}?message=Hole+${holeNumber}+cleared`);
      }

      const grossScore = parseInt(grossInput, 10);
      if (isNaN(grossScore) || grossScore < 1 || grossScore > 25) {
        return res.redirect(`${returnUrl}?error=Gross+must+be+between+1+and+25`);
      }

      const shots = strokesForHole(courseHcp, hole.stroke_index_primary, hole.stroke_index_secondary);
      const stablefordPoints = Math.max(0, 2 + shots - (grossScore - hole.par));

      if (existing) {
        await db('scorecard_holes').where({ id: existing.id }).update({ gross_score: grossScore, stableford_points: stablefordPoints, updated_at: db.fn.now() });
      } else {
        await db('scorecard_holes').insert({ scorecard_id: scorecard.id, hole_number: holeNumber, gross_score: grossScore, stableford_points: stablefordPoints, version: 1 });
      }

      await db('scorecard_edit_logs').insert({ scorecard_id: scorecard.id, hole_number: holeNumber, previous_gross_score: prevGross, previous_stableford_points: prevStableford, new_gross_score: grossScore, new_stableford_points: stablefordPoints, editor_user_id: req.session.user.id });
      await db('tours').where({ id: tourId }).update({ leaderboard_dirty_at: db.fn.now() });

      return res.redirect(`${returnUrl}?message=Hole+${holeNumber}+updated`);
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Round config — score count (for open→draft confirmation)
  // -------------------------------------------------------------------------
  router.get('/tours/:tourId/rounds/:roundNumber/score-count', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const roundNumber = parseInt(req.params.roundNumber, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).json({ error: 'Not found' });
      const holesRow = await db('scorecard_holes as sh')
        .join('scorecards as s', 's.id', 'sh.scorecard_id')
        .where({ 's.tour_id': tourId, 's.round_number': roundNumber })
        .count('sh.id as total').first();
      const playersRow = await db('scorecards')
        .where({ tour_id: tourId, round_number: roundNumber })
        .whereNotNull('user_id')
        .countDistinct('user_id as total').first();
      return res.json({
        holesScored: Number(holesRow?.total || 0),
        playersScored: Number(playersRow?.total || 0),
      });
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Novelty events — create / delete / save results
  // -------------------------------------------------------------------------
  router.post('/tours/:tourId/rounds/:roundNumber/novelties', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const roundNumber = parseInt(req.params.roundNumber, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
      if (!round) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`)}?error=Round+not+found`);
      }

      const noveltyType = String(req.body.noveltyType || '');
      const label = String(req.body.label || '').trim() || noveltyType;

      if (!NOVELTY_TYPES.includes(noveltyType)) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`)}?error=Invalid+novelty+type`);
      }

      const isOther = noveltyType === 'Other';
      const holeNumber = isOther ? null : parseInt(req.body.holeNumber, 10);
      const prizeAmount = isOther ? (parseInt(req.body.prizeAmount, 10) || null) : null;

      if (!isOther && (!holeNumber || holeNumber < 1 || holeNumber > 18)) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`)}?error=Invalid+hole+number`);
      }
      if (!isOther && !round.course_id) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`)}?error=Round+must+have+a+course+before+adding+NTP+or+Long+Drive+events`);
      }

      await createNoveltyEvent(db, { tour_id: tourId, round_number: roundNumber, course_id: isOther ? null : round.course_id, hole_number: holeNumber, novelty_type: noveltyType, label, prize_amount: prizeAmount });
      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`)}?message=Novelty+event+added`);
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/rounds/:roundNumber/novelties/:noveltyId/delete', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const roundNumber = parseInt(req.params.roundNumber, 10);
      const noveltyId = parseInt(req.params.noveltyId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const ne = await db('novelty_events').where({ id: noveltyId, tour_id: tourId, round_number: roundNumber }).first();
      if (ne) await removeNoveltyEvent(db, ne.id);
      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`)}?message=Novelty+event+removed`);
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/rounds/:roundNumber/novelties/results', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const roundNumber = parseInt(req.params.roundNumber, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const noveltyEvents = await findNoveltyEvents(db, tourId, roundNumber);
      for (const ne of noveltyEvents) {
        const raw = req.body[`winner_${ne.id}`];
        if (raw === 'no_winner') {
          await setNoveltyResult(db, ne.id, { winner_user_id: null, winner_team_id: null, is_no_winner: true, tour_id: tourId, round_number: roundNumber });
        } else if (raw) {
          const winnerId = parseInt(raw, 10);
          if (winnerId) {
            await setNoveltyResult(db, ne.id, { winner_user_id: winnerId, winner_team_id: null, is_no_winner: false, tour_id: tourId, round_number: roundNumber });
          }
        }
      }
      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`)}?message=Novelty+results+saved`);
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Seed test scores (tour 1 only)
  // -------------------------------------------------------------------------
  router.post('/tours/:tourId/rounds/:roundNumber/seed-scores', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      if (!req.tenant?.is_test_tenant) return res.status(403).send('Not available');

      const roundNumber = parseInt(req.params.roundNumber, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
      if (!round || round.status !== 'open') {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${roundNumber}&error=Round+must+be+open+to+seed+scores`);
      }

      const course = await db('courses').where({ id: round.course_id }).first();
      if (!course) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${roundNumber}&error=Course+not+found`);
      }

      const holes = await db('holes').where({ course_id: course.id }).orderBy('hole_number');
      if (!holes.length) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${roundNumber}&error=Course+has+no+holes+configured`);
      }

      const coursePar = holes.reduce((s, h) => s + Number(h.par || 0), 0);
      const allScorecards = await db('scorecards').where({ tour_id: tourId, round_number: roundNumber, type: 'individual' }).whereNotNull('user_id');

      // Skip cards that already have any holes scored
      const scoredIds = new Set(
        (await db('scorecard_holes')
          .whereIn('scorecard_id', allScorecards.map((s) => s.id))
          .distinct('scorecard_id')
          .select('scorecard_id'))
          .map((r) => Number(r.scorecard_id))
      );
      const scorecards = allScorecards.filter((s) => !scoredIds.has(Number(s.id)));

      const tourHandicaps = await db('player_handicaps').where({ tour_id: tourId });
      const tourHcpMap = new Map(tourHandicaps.map((h) => [Number(h.user_id), Number(h.playing_handicap)]));
      const roundHandicaps = await db('player_day_handicaps').where({ tour_id: tourId, round_number: roundNumber });
      const roundHcpMap = new Map(roundHandicaps.map((h) => [Number(h.user_id), Number(h.handicap_index)]));

      // Stableford distribution: net birdie 8%, net par 42%, net bogey 38%, net double 12%
      function pickStablefordPoints() {
        const r = Math.random() * 100;
        if (r < 8) return 3;
        if (r < 50) return 2;
        if (r < 88) return 1;
        return 0;
      }

      for (const sc of scorecards) {
        const userId = Number(sc.user_id);
        const isOverride = roundHcpMap.has(userId);
        const idx = isOverride ? roundHcpMap.get(userId) : (tourHcpMap.get(userId) ?? null);
        const courseHandicap = idx !== null
          ? (isOverride ? Math.round(idx) : computeCourseHandicap(idx, course.slope_rating, course.course_rating, coursePar, null))
          : 18;

        for (const hole of holes) {
          const strokes = strokesForHole(courseHandicap, hole.stroke_index_primary, hole.stroke_index_secondary);
          const stablefordPoints = pickStablefordPoints();
          const grossScore = Math.max(1, hole.par + strokes + 2 - stablefordPoints);
          await db('scorecard_holes')
            .insert({ scorecard_id: sc.id, hole_number: hole.hole_number, gross_score: grossScore, stableford_points: stablefordPoints, version: 1 })
            .onConflict(['scorecard_id', 'hole_number'])
            .ignore();
        }

        await db('scorecards').where({ id: sc.id }).update({ status: 'draft', updated_at: db.fn.now() });
      }

      const skipped = allScorecards.length - scorecards.length;
      const msg = scorecards.length
        ? `Scores+seeded+for+${scorecards.length}+player(s)${skipped ? `+(${skipped}+already+had+scores)` : ''}`
        : `All+${skipped}+player(s)+already+have+scores`;

      const returnTo = req.body.returnTo === 'round-config'
        ? res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`)
        : `${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${roundNumber}`;
      return res.redirect(`${returnTo}?message=${msg}`);
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/rounds/:roundNumber/unsubmit-scores', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      if (!req.tenant?.is_test_tenant) return res.status(403).send('Not available');
      const roundNumber = parseInt(req.params.roundNumber, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const count = await db('scorecards')
        .where({ tour_id: tourId, round_number: roundNumber, status: 'submitted' })
        .update({ status: 'draft', updated_at: db.fn.now() });

      const returnTo = req.body.returnTo === 'round-config'
        ? res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`)
        : `${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${roundNumber}`;
      return res.redirect(`${returnTo}?message=${count}+scorecard(s)+unsubmitted`);
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/rounds/:roundNumber/submit-all-scores', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      if (!req.tenant?.is_test_tenant) return res.status(403).send('Not available');
      const roundNumber = parseInt(req.params.roundNumber, 10);

      const returnTo = req.body.returnTo === 'round-config'
        ? res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`)
        : `${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${roundNumber}`;

      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
      if (!round || round.status !== 'open') {
        return res.redirect(`${returnTo}?error=Round+must+be+open+to+submit+scores`);
      }

      const pending = await db('scorecards')
        .where({ tour_id: tourId, round_number: roundNumber })
        .whereNot({ status: 'submitted' });

      if (!pending.length) {
        return res.redirect(`${returnTo}?message=All+scorecards+already+submitted`);
      }

      // Count holes per pending card — block if any have incomplete scores
      const course = await db('courses').where({ id: round.course_id }).first();
      const holeCount = course
        ? Number((await db('holes').where({ course_id: course.id }).count('id as n').first()).n)
        : 18;

      const holeCounts = await db('scorecard_holes')
        .whereIn('scorecard_id', pending.map((s) => s.id))
        .groupBy('scorecard_id')
        .select('scorecard_id')
        .count('hole_number as n');
      const holeCountMap = new Map(holeCounts.map((r) => [Number(r.scorecard_id), Number(r.n)]));

      const unscored = pending.filter((s) => (holeCountMap.get(Number(s.id)) || 0) < holeCount);
      if (unscored.length) {
        return res.redirect(`${returnTo}?error=${encodeURIComponent(`${unscored.length} scorecard(s) have incomplete scores — seed scores first`)}`);
      }

      const count = await db('scorecards')
        .whereIn('id', pending.map((s) => s.id))
        .update({ status: 'submitted', updated_at: db.fn.now() });

      await markLeaderboardDirty(db, tourId);

      return res.redirect(`${returnTo}?message=${count}+scorecard(s)+submitted`);
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Round config — POST
  // -------------------------------------------------------------------------
  router.post('/tours/:tourId/rounds/:roundNumber', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const roundNumber = parseInt(req.params.roundNumber, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const courseId = parseInt(req.body.courseId, 10);
      const calcType = String(req.body.calcType || CALC_TYPES.STABLEFORD);
      const status = String(req.body.status || 'draft');
      const leaderboardPublished = Boolean(req.body.leaderboardPublished);
      const showInProgress = Boolean(req.body.showInProgress);
      const twoBallEnabled = Boolean(req.body.twoBallEnabled);
      const twoBallType = twoBallEnabled ? String(req.body.twoBallType || 'best_ball') : null;
      const virtualTeamsEnabled = Boolean(req.body.virtualTeamsEnabled);
      const tourDate = req.body.tourDate ? String(req.body.tourDate) : null;
      const femaleCourseIdRaw = req.body.femaleCourseId ? parseInt(req.body.femaleCourseId, 10) : null;

      const course = await db('courses').where(courseWhere(req.tenant, { id: courseId })).first();
      if (!course) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`)}?error=Invalid+course`);
      }

      let femaleCourseId = null;
      if (tour.gender === 'mixed' && femaleCourseIdRaw) {
        const femaleCourse = await db('courses').where(courseWhere(req.tenant, { id: femaleCourseIdRaw })).first();
        if (femaleCourse) femaleCourseId = femaleCourse.id;
      }

      const ambroseLabels = [].concat(req.body.ambrose_prize_label || []);
      const ambroseAmounts = [].concat(req.body.ambrose_prize_amount || []);
      const ambrosePrizes = calcType === CALC_TYPES.AMBROSE_NETT
        ? ambroseLabels
            .map((label, i) => ({ label: String(label).trim(), amount: parseFloat(ambroseAmounts[i]) || 0 }))
            .filter((p) => p.label)
        : [];

      const existing = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();

      if (status === 'draft' && existing?.status === 'open') {
        if (req.body.confirmDeleteScores !== '1') {
          return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`)}?error=Confirm+score+deletion+before+reverting+to+draft`);
        }
        const scorecardIds = await db('scorecards').where({ tour_id: tourId, round_number: roundNumber }).pluck('id');
        if (scorecardIds.length) {
          await db('scorecard_holes').whereIn('scorecard_id', scorecardIds).delete();
        }
        await db('scorecards').where({ tour_id: tourId, round_number: roundNumber }).delete();
        await db('novelty_results').where({ tour_id: tourId, round_number: roundNumber }).delete();
        invalidateRoundCourseCache(tourId, roundNumber);
      }

      if (existing) {
        await db('golf_rounds').where({ id: existing.id }).update({
          course_id: courseId, calc_type: calcType, status,
          leaderboard_published: leaderboardPublished,
          leaderboard_show_in_progress: showInProgress,
          ambrose_prizes: JSON.stringify(ambrosePrizes),
          two_ball_enabled: twoBallEnabled, two_ball_type: twoBallType,
          virtual_teams_enabled: virtualTeamsEnabled,
          tour_date: tourDate,
          female_course_id: femaleCourseId,
        });
      } else {
        await db('golf_rounds').insert({
          tour_id: tourId, round_number: roundNumber, course_id: courseId, calc_type: calcType, status,
          leaderboard_published: leaderboardPublished,
          leaderboard_show_in_progress: showInProgress,
          ambrose_prizes: JSON.stringify(ambrosePrizes),
          two_ball_enabled: twoBallEnabled, two_ball_type: twoBallType,
          virtual_teams_enabled: virtualTeamsEnabled,
          tour_date: tourDate,
          female_course_id: femaleCourseId,
        });
      }

      if (status === 'open') {
        await ensureDayScorecards(db, tourId, roundNumber, calcType);
        await warmRoundCourseCache(db, tourId, roundNumber);
      }

      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Round+${roundNumber}+saved`);
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/rounds/:roundNumber/delete', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const roundNumber = parseInt(req.params.roundNumber, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
      if (!round) return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?error=Round+not+found`);
      if (round.status !== 'draft') {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/rounds/${roundNumber}`)}?error=Only+draft+rounds+can+be+deleted`);
      }

      const teeGroupIds = await db('tee_groups').where({ tour_id: tourId, round_number: roundNumber }).pluck('id');
      if (teeGroupIds.length) {
        await db('tee_group_players').whereIn('tee_group_id', teeGroupIds).delete();
        await db('tee_groups').whereIn('id', teeGroupIds).delete();
      }
      const teamIds = await db('teams').where({ tour_id: tourId, round_number: roundNumber }).pluck('id');
      if (teamIds.length) {
        await db('team_members').whereIn('team_id', teamIds).delete();
        await db('teams').whereIn('id', teamIds).delete();
      }
      await db('player_day_handicaps').where({ tour_id: tourId, round_number: roundNumber }).delete();
      await db('novelty_events').where({ tour_id: tourId, round_number: roundNumber }).delete();
      await db('golf_rounds').where({ id: round.id }).delete();

      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Round+${roundNumber}+deleted`);
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Add player to tour
  // -------------------------------------------------------------------------
  router.post('/tours/:tourId/players', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const userId = parseInt(req.body.userId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const membership = await db('tenant_memberships')
        .where({ tenant_id: req.tenant.id, user_id: userId }).first();
      if (!membership) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?error=User+is+not+a+member+of+this+tour`);
      }

      const existing = await db('event_players').where({ tour_id: tourId, user_id: userId }).first();
      if (!existing) {
        await db('event_players').insert({ tour_id: tourId, user_id: userId, status: 'active' });
      }

      res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Player+added`);
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Enroll player into tour — find/create user, ensure tenant membership, add to tour
  // -------------------------------------------------------------------------
  router.post('/tours/:tourId/enroll-player', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const email = String(req.body.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?error=Valid+email+is+required`);
      }

      const firstName = String(req.body.firstName || '').trim();
      const lastName = String(req.body.lastName || '').trim();
      const phoneNumber = String(req.body.phoneNumber || '').replace(/\D/g, '') || null;
      const gender = req.body.gender === 'female' ? 'female' : 'male';
      const handicap = parseFloat(req.body.playingHandicap);

      let user = await db('users').whereRaw('lower(email) = ?', [email]).first();
      const isNewUser = !user;
      if (!user) {
        if (!firstName || !lastName) {
          return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?error=First+and+last+name+required+for+new+players`);
        }
        [user] = await db('users').insert({
          first_name: firstName,
          last_name: lastName,
          email,
          phone_number: phoneNumber,
          gender,
          email_verified_at: db.fn.now(),
        }).returning('*');
      }

      const membership = await db('tenant_memberships')
        .where({ tenant_id: req.tenant.id, user_id: user.id }).first();
      if (!membership) {
        await db('tenant_memberships').insert({
          tenant_id: req.tenant.id,
          user_id: user.id,
          role: 'player',
          invited_by_user_id: req.session.user.id,
        });
      }

      const existing = await db('event_players').where({ tour_id: tourId, user_id: user.id }).first();
      if (!existing) {
        await db('event_players').insert({ tour_id: tourId, user_id: user.id, status: 'active' });
      }

      if (Number.isFinite(handicap)) {
        await db('player_handicaps')
          .insert({ tour_id: tourId, user_id: user.id, playing_handicap: handicap })
          .onConflict(['tour_id', 'user_id']).merge({ playing_handicap: handicap });
      }

      const inviter = req.session.user;
      const inviterName = `${inviter.firstName || ''} ${inviter.lastName || ''}`.trim() || 'Your tour admin';
      let emailWarning = null;
      try {
        await sendWelcomeEmail({
          email: user.email,
          firstName: user.first_name,
          tourLabel: tour.label,
          tenantName: req.tenant.name,
          tenantSlug: req.tenant.slug,
          inviterName,
          isNewUser,
        });
      } catch (emailErr) {
        console.error('[welcome-email] failed:', emailErr?.message);
        emailWarning = `Player enrolled, but the welcome email to ${user.email} could not be sent — please follow up manually.`;
      }

      const qs = emailWarning
        ? `error=${encodeURIComponent(emailWarning)}`
        : `message=Player+enrolled+%E2%80%94+welcome+email+sent`;
      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?${qs}`);
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Resend welcome email to a player
  // -------------------------------------------------------------------------
  router.post('/tours/:tourId/players/:userId/send-welcome', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const userId = parseInt(req.params.userId, 10);
      const base = res.locals.tenantPath(`/admin/tours/${tourId}`);

      const [tour, user] = await Promise.all([
        db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first(),
        db('users').where({ id: userId }).first(),
      ]);
      if (!tour || !user) return res.status(404).send('Not found');

      const inviter = req.session.user;
      const inviterName = `${inviter.firstName || ''} ${inviter.lastName || ''}`.trim() || 'Your tour admin';

      try {
        await sendWelcomeEmail({
          email: user.email,
          firstName: user.first_name,
          tourLabel: tour.label,
          tenantName: req.tenant.name,
          tenantSlug: req.tenant.slug,
          inviterName,
          isNewUser: true,
        });
        return res.redirect(`${base}?message=${encodeURIComponent(`Welcome email resent to ${user.email}`)}`);
      } catch (emailErr) {
        console.error('[welcome-email] resend failed:', emailErr?.message);
        return res.redirect(`${base}?error=${encodeURIComponent(`Could not send email to ${user.email} — please try again or contact them directly.`)}`);
      }
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Update player (handicap)
  // -------------------------------------------------------------------------
  router.post('/tours/:tourId/players/:userId/update', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const userId = parseInt(req.params.userId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const handicap = req.body.playingHandicap !== '' ? parseFloat(req.body.playingHandicap) : null;
      if (handicap !== null && Number.isFinite(handicap)) {
        const existing = await db('player_handicaps').where({ tour_id: tourId, user_id: userId }).first();
        if (existing) {
          await db('player_handicaps').where({ id: existing.id }).update({ playing_handicap: handicap });
        } else {
          await db('player_handicaps').insert({ tour_id: tourId, user_id: userId, playing_handicap: handicap });
        }
      }

      if (req.body.gender === 'male' || req.body.gender === 'female') {
        await db('users').where({ id: userId }).update({ gender: req.body.gender });
      }

      res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Player+updated`);
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Remove player from tour
  // -------------------------------------------------------------------------
  router.post('/tours/:tourId/players/:userId/delete', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const userId = parseInt(req.params.userId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      await db('event_players').where({ tour_id: tourId, user_id: userId }).delete();
      await db('player_handicaps').where({ tour_id: tourId, user_id: userId }).delete();

      res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Player+removed`);
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Set player role (player ↔ scorer) — tour admin and above
  // -------------------------------------------------------------------------
  router.post('/tours/:tourId/players/:userId/set-role', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const userId = parseInt(req.params.userId, 10);
      const role = req.body.role;

      if (role !== 'player' && role !== 'scorer') {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?error=Invalid+role`);
      }

      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const inTour = await db('event_players').where({ tour_id: tourId, user_id: userId }).first();
      if (!inTour) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?error=Player+not+in+this+tour`);
      }

      // Only allow downgrading from admin/owner if the requester is a tenant admin
      const currentMembership = await db('tenant_memberships')
        .where({ tenant_id: req.tenant.id, user_id: userId }).first();
      if (currentMembership?.role === 'admin' || currentMembership?.role === 'owner') {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?error=Cannot+change+role+of+tenant+admins`);
      }

      await db('tenant_memberships')
        .where({ tenant_id: req.tenant.id, user_id: userId })
        .update({ role });

      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Role+updated`);
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Tour admins — add / remove (tour admin and above)
  // -------------------------------------------------------------------------
  router.post('/tours/:tourId/tour-admins', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const userId = parseInt(req.body.userId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const membership = await db('tenant_memberships').where({ tenant_id: req.tenant.id, user_id: userId }).first();
      if (!membership) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?error=User+is+not+a+tenant+member`);
      }

      await db('tour_admins').insert({ tour_id: tourId, user_id: userId }).onConflict(['tour_id', 'user_id']).ignore();
      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Tour+admin+added`);
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/tour-admins/:userId/delete', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const userId = parseInt(req.params.userId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      await db('tour_admins').where({ tour_id: tourId, user_id: userId }).delete();
      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Tour+admin+removed`);
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Virtual teams — CRUD (tour admin and above)
  // -------------------------------------------------------------------------

  router.post('/tours/:tourId/virtual-teams', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');
      const name = String(req.body.name || '').trim();
      if (!name) return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?error=Team+name+required`);
      await virtualTeamsRepo.create(db, tourId, name);
      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Team+created`);
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/virtual-teams/:teamId/rename', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const teamId = parseInt(req.params.teamId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');
      const team = await db('virtual_teams').where({ id: teamId, tour_id: tourId }).first();
      if (!team) return res.status(404).send('Team not found');
      const name = String(req.body.name || '').trim();
      if (!name) return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?error=Team+name+required`);
      await virtualTeamsRepo.rename(db, teamId, name);
      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Team+renamed`);
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/virtual-teams/:teamId/delete', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const teamId = parseInt(req.params.teamId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');
      const team = await db('virtual_teams').where({ id: teamId, tour_id: tourId }).first();
      if (!team) return res.status(404).send('Team not found');
      await virtualTeamsRepo.remove(db, teamId);
      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Team+deleted`);
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/virtual-teams/:teamId/players', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const teamId = parseInt(req.params.teamId, 10);
      const userId = parseInt(req.body.userId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');
      const team = await db('virtual_teams').where({ id: teamId, tour_id: tourId }).first();
      if (!team) return res.status(404).send('Team not found');
      const inTour = await db('event_players').where({ tour_id: tourId, user_id: userId }).first();
      if (!inTour) return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?error=Player+not+in+tour`);
      await virtualTeamsRepo.addPlayer(db, tourId, teamId, userId);
      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Player+added+to+team`);
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/virtual-teams/:teamId/players/:userId/delete', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const teamId = parseInt(req.params.teamId, 10);
      const userId = parseInt(req.params.userId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');
      await virtualTeamsRepo.removePlayer(db, teamId, userId);
      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}`)}?message=Player+removed+from+team`);
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Members — list
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Session logs
  // -------------------------------------------------------------------------
  router.get('/session-logs', superAdminGuard, async (req, res, next) => {
    try {
      const PAGE_SIZE = 50;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;

      const query = db('session_logs as sl')
        .leftJoin('users as u', 'u.id', 'sl.user_id')
        .where('sl.tenant_id', req.tenant.id)
        .select(
          'sl.id', 'sl.event', 'sl.ip_address', 'sl.user_agent', 'sl.created_at',
          'u.id as userId', 'u.first_name', 'u.last_name', 'u.email'
        )
        .orderBy('sl.created_at', 'desc');

      if (userId) query.where('sl.user_id', userId);

      const [{ count }] = await query.clone().clearSelect().clearOrder().count('sl.id as count');
      const logs = await query.limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE);

      const members = await db('tenant_memberships as m')
        .join('users as u', 'u.id', 'm.user_id')
        .where('m.tenant_id', req.tenant.id)
        .select('u.id', 'u.first_name', 'u.last_name', 'u.email')
        .orderBy(['u.first_name', 'u.last_name']);

      res.render('admin/session-logs', {
        title: 'Session Logs',
        user: req.session.user,
        logs,
        members,
        page,
        pageSize: PAGE_SIZE,
        total: Number(count),
        filterUserId: userId,
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { next(err); }
  });

  router.get('/players', guard, async (req, res, next) => {
    try {
      const members = await db('tenant_memberships as m')
        .join('users as u', 'u.id', 'm.user_id')
        .where('m.tenant_id', req.tenant.id)
        .select('m.*', 'u.first_name', 'u.last_name', 'u.email', 'u.phone_number', 'u.gender')
        .orderBy(['u.first_name', 'u.last_name']);

      res.render('admin/players', {
        title: 'Players',
        user: req.session.user,
        members,
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { next(err); }
  });

  // Create user + add as member, or add existing user as member
  router.post('/players', guard, async (req, res, next) => {
    try {
      const { firstName, lastName, email, phoneNumber, role } = req.body;
      const normalizedEmail = String(email || '').trim().toLowerCase();
      const validRoles = ['player', 'scorer', 'admin', 'owner'];
      const memberRole = validRoles.includes(role) ? role : 'player';
      const gender = req.body.gender === 'female' ? 'female' : 'male';

      if (memberRole === 'owner' && req.tenantMembership?.role !== 'owner') {
        return res.redirect(`${res.locals.tenantPath('/admin/players')}?error=Only+owners+can+assign+owner+role`);
      }

      let user = await db('users').where({ email: normalizedEmail }).first();
      if (!user) {
        [user] = await db('users').insert({
          first_name: String(firstName || '').trim(),
          last_name: String(lastName || '').trim(),
          email: normalizedEmail,
          phone_number: phoneNumber ? String(phoneNumber).replace(/\D/g, '') || null : null,
          email_verified_at: db.fn.now(),
          gender,
        }).returning('*');
      }

      const existing = await db('tenant_memberships')
        .where({ tenant_id: req.tenant.id, user_id: user.id }).first();
      if (!existing) {
        await db('tenant_memberships').insert({
          tenant_id: req.tenant.id,
          user_id: user.id,
          role: memberRole,
          invited_by_user_id: req.session.user.id,
        });
      }

      res.redirect(`${res.locals.tenantPath('/admin/players')}?message=Player+added`);
    } catch (err) { next(err); }
  });

  // Update member role
  router.post('/members/:userId/role', guard, async (req, res, next) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      const { role } = req.body;
      const validRoles = ['player', 'scorer', 'admin', 'owner'];
      if (!validRoles.includes(role)) {
        return res.redirect(`${res.locals.tenantPath('/admin/players')}?error=Invalid+role`);
      }
      if (role === 'owner' && req.tenantMembership?.role !== 'owner') {
        return res.redirect(`${res.locals.tenantPath('/admin/players')}?error=Only+owners+can+assign+owner+role`);
      }

      const target = await db('tenant_memberships')
        .where({ tenant_id: req.tenant.id, user_id: userId }).first();
      if (target && target.role === 'owner' && role !== 'owner') {
        const ownerCount = await db('tenant_memberships')
          .where({ tenant_id: req.tenant.id, role: 'owner' }).count('id as n').first();
        if (Number(ownerCount.n) <= 1) {
          return res.redirect(`${res.locals.tenantPath('/admin/players')}?error=Cannot+demote+the+last+owner`);
        }
      }

      await db('tenant_memberships')
        .where({ tenant_id: req.tenant.id, user_id: userId })
        .update({ role });
      return res.redirect(`${res.locals.tenantPath('/admin/players')}?message=Role+updated`);
    } catch (err) { return next(err); }
  });

  // Update member gender
  router.post('/members/:userId/update', guard, async (req, res, next) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      const membership = await db('tenant_memberships')
        .where({ tenant_id: req.tenant.id, user_id: userId }).first();
      if (!membership) return res.status(404).send('Member not found');

      const gender = req.body.gender === 'female' ? 'female' : 'male';
      await db('users').where({ id: userId }).update({ gender });
      return res.redirect(`${res.locals.tenantPath('/admin/players')}?message=Player+updated`);
    } catch (err) { return next(err); }
  });

  // Remove member
  router.post('/members/:userId/remove', guard, async (req, res, next) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (userId === req.session.user.id) {
        return res.redirect(`${res.locals.tenantPath('/admin/players')}?error=Cannot+remove+yourself`);
      }

      const target = await db('tenant_memberships')
        .where({ tenant_id: req.tenant.id, user_id: userId }).first();
      if (target && target.role === 'owner') {
        const ownerCount = await db('tenant_memberships')
          .where({ tenant_id: req.tenant.id, role: 'owner' }).count('id as n').first();
        if (Number(ownerCount.n) <= 1) {
          return res.redirect(`${res.locals.tenantPath('/admin/players')}?error=Cannot+remove+the+last+owner`);
        }
      }

      await db('tenant_memberships')
        .where({ tenant_id: req.tenant.id, user_id: userId })
        .delete();
      return res.redirect(`${res.locals.tenantPath('/admin/players')}?message=Member+removed`);
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Courses — list
  // -------------------------------------------------------------------------
  router.get('/courses', anyAdminGuard, async (req, res, next) => {
    try {
      const courses = await db('courses as c')
        .leftJoin('holes as h', 'h.course_id', 'c.id')
        .where('c.tenant_id', req.tenant.id)
        .groupBy('c.id', 'c.course_name', 'c.tee_name', 'c.gender', 'c.api_course_id')
        .select('c.id', 'c.course_name', 'c.tee_name', 'c.gender', 'c.api_course_id')
        .count('h.id as holes_count')
        .orderBy([{ column: 'c.course_name' }, { column: 'c.tee_name' }]);

      const usedRows = await db('golf_rounds as gr')
        .join('tours as t', 't.id', 'gr.tour_id')
        .where('t.tenant_id', req.tenant.id)
        .select('gr.course_id');
      const usedCourseIds = new Set(usedRows.map((r) => r.course_id));

      res.render('admin/courses', {
        title: 'Courses',
        user: req.session.user,
        courses: courses.map((c) => ({ ...c, in_use: usedCourseIds.has(c.id) })),
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Courses — create
  // -------------------------------------------------------------------------
  router.post('/courses', anyAdminGuard, async (req, res, next) => {
    try {
      const courseName = String(req.body.courseName || '').trim();
      const teeName = String(req.body.teeName || '').trim();
      if (!courseName || !teeName) {
        return res.redirect(`${res.locals.tenantPath('/admin/courses')}?error=Course+name+and+tee+name+are+required`);
      }

      const validCourseGenders = ['mens', 'womens', 'open'];
      const courseGender = validCourseGenders.includes(req.body.gender) ? req.body.gender : 'mens';
      const supportsSplitRatings = req.body.supportsSplitRatings === '1';
      const [course] = await db('courses').insert({
        tenant_id: req.tenant.id,
        course_name: courseName,
        tee_name: teeName,
        gender: courseGender,
        supports_split_ratings: supportsSplitRatings,
      }).returning('*');

      const blankHoles = Array.from({ length: 18 }, (_, i) => ({
        course_id: course.id,
        hole_number: i + 1,
        par: 4,
        stroke_index_primary: i + 1,
        stroke_index_secondary: i + 19,
        length_meters: null,
      }));
      await db('holes').insert(blankHoles);

      res.redirect(`${res.locals.tenantPath(`/admin/courses/${course.id}`)}?message=Course+created+-+update+hole+details+below`);
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Courses — import from Golf API (must be before /:courseId routes)
  // -------------------------------------------------------------------------
  router.get('/courses/import', anyAdminGuard, (req, res) => {
    return res.render('admin/course-import', {
      title: 'Import Course',
      user: req.session.user,
      hasApiKey: Boolean(golfCourseApiKey),
      error: req.query.error || null,
    });
  });

  router.get('/courses/import/search', anyAdminGuard, async (req, res, next) => {
    try {
      if (!golfCourseApiKey) return res.status(503).json({ error: 'API key not configured' });
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ courses: [] });
      const data = await golfApiGet(`/search?search_query=${encodeURIComponent(q)}`);
      return res.json({ courses: data.courses || [] });
    } catch (err) { return next(err); }
  });

  router.get('/courses/import/course/:id(\\d+)', anyAdminGuard, async (req, res, next) => {
    try {
      if (!golfCourseApiKey) return res.status(503).json({ error: 'API key not configured' });
      const data = await golfApiGet(`/courses/${req.params.id}`);
      return res.json(data);
    } catch (err) { return next(err); }
  });

  router.post('/courses/import', anyAdminGuard, async (req, res, next) => {
    try {
      const apiCourseId = parseInt(req.body.apiCourseId, 10);
      const apiTeeName = String(req.body.apiTeeName || '').trim();
      const apiGender = String(req.body.gender || 'male'); // 'male'|'female' from import UI
      const courseGenderStored = apiGender === 'female' ? 'womens' : 'mens';
      const courseName = String(req.body.courseName || '').trim();
      const teeName = String(req.body.teeName || '').trim();
      const holesJson = String(req.body.holesJson || '[]');
      const apiTeeKey = `${apiGender === 'female' ? 'f' : 'm'}:${apiTeeName}`;

      if (!apiCourseId || !apiTeeName || !courseName || !teeName) {
        return res.redirect(`${res.locals.tenantPath('/admin/courses/import')}?error=Missing+required+fields`);
      }

      let apiHoles;
      try { apiHoles = JSON.parse(holesJson); } catch {
        return res.redirect(`${res.locals.tenantPath('/admin/courses/import')}?error=Invalid+hole+data`);
      }
      if (!Array.isArray(apiHoles) || apiHoles.length < 18) {
        return res.redirect(`${res.locals.tenantPath('/admin/courses/import')}?error=Course+does+not+have+18+holes`);
      }

      const existing = await db('courses')
        .where({ tenant_id: req.tenant.id, api_course_id: apiCourseId, api_tee_key: apiTeeKey })
        .first();
      if (existing) {
        const label = `${existing.course_name} — ${existing.tee_name}`;
        return res.redirect(`${res.locals.tenantPath('/admin/courses/import')}?error=${encodeURIComponent(`Already imported as "${label}"`)}`);
      }

      const courseRating = req.body.courseRating ? parseFloat(req.body.courseRating) : null;
      const slopeRating = req.body.slopeRating ? parseInt(req.body.slopeRating, 10) : null;

      const [course] = await db('courses').insert({
        tenant_id: req.tenant.id,
        course_name: courseName,
        tee_name: teeName,
        gender: courseGenderStored,
        course_rating: Number.isFinite(courseRating) ? courseRating : null,
        slope_rating: Number.isFinite(slopeRating) ? slopeRating : null,
        api_course_id: apiCourseId,
        api_tee_key: apiTeeKey,
      }).returning('*');

      const holes = apiHoles.slice(0, 18).map((h, i) => {
        const siP = h.handicap || (i + 1);
        return {
          course_id: course.id,
          hole_number: i + 1,
          par: h.par || 4,
          length_meters: h.yardage ? Math.round(h.yardage * 0.9144) : null,
          stroke_index_primary: siP,
          stroke_index_secondary: siP + 18,
        };
      });
      await db('holes').insert(holes);

      res.redirect(`${res.locals.tenantPath(`/admin/courses/${course.id}`)}?message=Course+imported+-+review+SI+secondary+values`);
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Course detail — edit name/tee + holes
  // -------------------------------------------------------------------------
  router.get('/courses/:courseId', anyAdminGuard, async (req, res, next) => {
    try {
      const courseId = parseInt(req.params.courseId, 10);
      const course = await db('courses').where(courseWhere(req.tenant, { id: courseId })).first();
      if (!course) return res.status(404).send('Course not found');

      // Tour admins cannot edit a course that is currently assigned to an open round
      if (!isTenantAdmin(req.tenantMembership)) {
        const openRound = await db('golf_rounds as gr')
          .join('tours as t', 't.id', 'gr.tour_id')
          .where('t.tenant_id', req.tenant.id)
          .where('gr.status', 'open')
          .where(function () {
            this.where('gr.course_id', courseId).orWhere('gr.female_course_id', courseId);
          })
          .first();
        if (openRound) {
          return res.redirect(
            `${res.locals.tenantPath('/admin/courses')}?error=${encodeURIComponent('This course is in use in an open round and cannot be edited right now.')}`
          );
        }
      }

      const holes = await db('holes').where({ course_id: courseId }).orderBy('hole_number');

      const hasOpenRound = await db('golf_rounds as gr')
        .join('tours as t', 't.id', 'gr.tour_id')
        .where('t.tenant_id', req.tenant.id)
        .where('gr.status', 'open')
        .where(function () {
          this.where('gr.course_id', courseId).orWhere('gr.female_course_id', courseId);
        })
        .first();

      const hasScores = await db('scorecard_holes as sh')
        .join('scorecards as s', 's.id', 'sh.scorecard_id')
        .join('golf_rounds as gr', function joinGr() {
          this.on('gr.tour_id', '=', 's.tour_id').andOn('gr.round_number', '=', 's.round_number');
        })
        .join('tours as t', 't.id', 's.tour_id')
        .where('t.tenant_id', req.tenant.id)
        .where('gr.course_id', courseId)
        .first();

      res.render('admin/course-edit', {
        title: `${course.course_name} — ${course.tee_name}`,
        user: req.session.user,
        course,
        holes,
        courseEditLocked: Boolean(hasScores),
        holesLocked: Boolean(hasOpenRound),
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { next(err); }
  });

  router.post('/courses/:courseId', anyAdminGuard, async (req, res, next) => {
    try {
      const courseId = parseInt(req.params.courseId, 10);
      const course = await db('courses').where(courseWhere(req.tenant, { id: courseId })).first();
      if (!course) return res.status(404).send('Course not found');

      if (!isTenantAdmin(req.tenantMembership)) {
        const openRound = await db('golf_rounds as gr')
          .join('tours as t', 't.id', 'gr.tour_id')
          .where('t.tenant_id', req.tenant.id)
          .where('gr.status', 'open')
          .where(function () {
            this.where('gr.course_id', courseId).orWhere('gr.female_course_id', courseId);
          })
          .first();
        if (openRound) return res.status(403).send('Course is in use in an open round');
      }

      const courseName = String(req.body.courseName || '').trim();
      const teeName = String(req.body.teeName || '').trim();
      if (!courseName || !teeName) {
        return res.redirect(`${res.locals.tenantPath(`/admin/courses/${courseId}`)}?error=Name+and+tee+required`);
      }
      const validCourseGenders = ['mens', 'womens', 'open'];
      const updatedCourseGender = validCourseGenders.includes(req.body.gender) ? req.body.gender : course.gender;
      const courseRating = req.body.courseRating !== '' ? parseFloat(req.body.courseRating) : null;
      const slopeRating = req.body.slopeRating !== '' ? parseInt(req.body.slopeRating, 10) : null;
      const supportsSplitRatings = req.body.supportsSplitRatings === '1';
      await db('courses').where({ id: courseId }).update({
        course_name: courseName,
        tee_name: teeName,
        gender: updatedCourseGender,
        course_rating: Number.isFinite(courseRating) ? courseRating : null,
        slope_rating: Number.isFinite(slopeRating) ? slopeRating : null,
        supports_split_ratings: supportsSplitRatings,
      });

      const hasOpenRound = await db('golf_rounds as gr')
        .join('tours as t', 't.id', 'gr.tour_id')
        .where('t.tenant_id', req.tenant.id)
        .where('gr.status', 'open')
        .where(function () {
          this.where('gr.course_id', courseId).orWhere('gr.female_course_id', courseId);
        })
        .first();

      if (!hasOpenRound) {
        const holes = await db('holes').where({ course_id: courseId }).orderBy('hole_number');
        await db.transaction(async (trx) => {
          for (const hole of holes) {
            const par = parseInt(req.body[`par_${hole.id}`], 10);
            const meters = req.body[`meters_${hole.id}`] !== '' ? parseInt(req.body[`meters_${hole.id}`], 10) : null;
            const siP = parseInt(req.body[`si_primary_${hole.id}`], 10);
            const siS = supportsSplitRatings
              ? parseInt(req.body[`si_secondary_${hole.id}`], 10)
              : siP + 18;
            if (Number.isFinite(par) && Number.isFinite(siP)) {
              await trx('holes').where({ id: hole.id }).update({
                par,
                length_meters: Number.isFinite(meters) ? meters : null,
                stroke_index_primary: siP,
                stroke_index_secondary: siS,
              });
            }
          }
        });
      }

      res.redirect(`${res.locals.tenantPath(`/admin/courses/${courseId}`)}?message=Course+saved`);
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Course delete
  // -------------------------------------------------------------------------
  router.post('/courses/:courseId/delete', guard, async (req, res, next) => {
    try {
      const courseId = parseInt(req.params.courseId, 10);
      const course = await db('courses').where({ id: courseId, tenant_id: req.tenant.id }).first();
      if (!course) return res.status(404).send('Course not found');

      const inUse = await db('golf_rounds as gr')
        .join('tours as t', 't.id', 'gr.tour_id')
        .where({ 'gr.course_id': courseId, 't.tenant_id': req.tenant.id })
        .first();
      if (inUse) {
        return res.redirect(`${res.locals.tenantPath('/admin/courses')}?error=Cannot+delete+a+course+that+is+assigned+to+a+round`);
      }

      await db('courses').where({ id: courseId }).delete();
      res.redirect(`${res.locals.tenantPath('/admin/courses')}?message=Course+deleted`);
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // Course duplicate
  // -------------------------------------------------------------------------
  router.post('/courses/:courseId/duplicate', anyAdminGuard, async (req, res, next) => {
    try {
      const courseId = parseInt(req.params.courseId, 10);
      const source = await db('courses').where(courseWhere(req.tenant, { id: courseId })).first();
      if (!source) return res.status(404).send('Course not found');

      const teeName = String(req.body.teeName || '').trim();
      if (!teeName) {
        return res.redirect(`${res.locals.tenantPath(`/admin/courses/${courseId}`)}?error=Tee+name+is+required`);
      }

      const sourceHoles = await db('holes').where({ course_id: courseId }).orderBy('hole_number');

      const [newCourse] = await db('courses').insert({
        tenant_id: req.tenant.id,
        course_name: source.course_name,
        tee_name: teeName,
        gender: source.gender,
        course_rating: source.course_rating,
        slope_rating: source.slope_rating,
        supports_split_ratings: source.supports_split_ratings,
        // API identifiers are intentionally omitted — the duplicate is a new tee variant
      }).returning('*');

      await db('holes').insert(sourceHoles.map((h) => ({
        course_id: newCourse.id,
        hole_number: h.hole_number,
        par: h.par,
        length_meters: h.length_meters,
        stroke_index_primary: h.stroke_index_primary,
        stroke_index_secondary: h.stroke_index_secondary,
      })));

      res.redirect(`${res.locals.tenantPath(`/admin/courses/${newCourse.id}`)}?message=Course+duplicated+-+update+tee+details+below`);
    } catch (err) { next(err); }
  });

  // ---------------------------------------------------------------------------
  // Tee times
  // ---------------------------------------------------------------------------

  async function teeTimes_loadDay(db, tenant, tourId, roundNumber) {
    const tour = await db('tours').where({ id: tourId, tenant_id: tenant.id }).first();
    if (!tour) return null;

    const roundRows = await db('golf_rounds').where({ tour_id: tourId }).orderBy('round_number').select('round_number', 'status');
    const allRoundNumbers = roundRows.map((r) => r.round_number);

    const round = roundRows.find((r) => r.round_number === roundNumber)
      ? await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first()
      : null;
    const courseId = round && round.course_id;

    let course = null;
    let coursePar = 0;
    if (courseId) {
      course = await db('courses').where({ id: courseId }).first();
      const parRow = await db('holes').where({ course_id: courseId }).sum('par as total').first();
      coursePar = Number(parRow && parRow.total) || 0;
    }

    const tourHandicaps = await db('player_handicaps').where({ tour_id: tourId });
    const tourHcpMap = new Map(tourHandicaps.map((h) => [Number(h.user_id), Number(h.playing_handicap)]));

    const roundHandicaps = await db('player_day_handicaps').where({ tour_id: tourId, round_number: roundNumber });
    const roundHcpMap = new Map(roundHandicaps.map((h) => [Number(h.user_id), Number(h.handicap_index)]));

    const rawPlayers = await db('event_players as ep')
      .join('users as u', 'u.id', 'ep.user_id')
      .where({ 'ep.tour_id': tourId, 'ep.status': 'active' })
      .select('ep.user_id', 'u.first_name', 'u.last_name', 'u.gender');

    const groups = await db('tee_groups as tg')
      .where({ 'tg.tour_id': tourId, 'tg.round_number': roundNumber })
      .orderBy('tg.group_number')
      .select('tg.*')
      .then(async (grps) => {
        for (const g of grps) {
          g.players = await db('tee_group_players as tgp')
            .join('users as u', 'u.id', 'tgp.user_id')
            .where({ 'tgp.tee_group_id': g.id })
            .orderBy('tgp.position')
            .select('tgp.user_id', 'tgp.position', 'u.first_name', 'u.last_name');
        }
        return grps;
      });

    const assignedUserIds = new Set(
      groups.flatMap((g) => g.players.map((p) => Number(p.user_id))),
    );

    const players = rawPlayers.map((p) => {
      const uid = Number(p.user_id);
      const tourIndex = tourHcpMap.get(uid) ?? null;
      const roundOverride = roundHcpMap.has(uid) ? roundHcpMap.get(uid) : null;
      const effectiveIndex = roundOverride ?? tourIndex;
      const isOverride = roundOverride !== null;
      const courseHandicap = (effectiveIndex !== null && course)
        ? (isOverride ? Math.round(effectiveIndex) : computeCourseHandicap(effectiveIndex, course.slope_rating, course.course_rating, coursePar, p.gender || null))
        : null;
      return {
        user_id: uid,
        name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        first_name: p.first_name,
        last_name: p.last_name,
        tourHandicapIndex: tourIndex,
        roundHandicapOverride: roundOverride,
        effectiveHandicapIndex: effectiveIndex,
        courseHandicap,
        assigned: assignedUserIds.has(uid),
      };
    });

    const noveltyEvents = round ? await findNoveltyEvents(db, tourId, roundNumber) : [];
    const noveltyResultsByEventId = {};
    for (const ne of noveltyEvents) {
      const result = await db('novelty_results').where({ novelty_event_id: ne.id }).first() || null;
      if (result && result.winner_user_id) {
        const winner = await db('users').where({ id: result.winner_user_id }).select('first_name', 'last_name').first();
        result.winnerName = winner ? `${winner.first_name || ''} ${winner.last_name || ''}`.trim() : null;
      }
      noveltyResultsByEventId[ne.id] = result;
    }

    return { tour, allRoundNumbers, roundNumber, round, course, coursePar, groups, players, noveltyEvents, noveltyResultsByEventId };
  }

  router.get('/tours/:tourId/tee-times', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const roundRows = await db('golf_rounds').where({ tour_id: tourId }).orderBy('round_number').select('round_number');
      const allRoundNumbers = roundRows.map((r) => r.round_number);
      const roundNumber = parseInt(req.query.round, 10) || allRoundNumbers[0] || 1;

      const data = await teeTimes_loadDay(db, req.tenant, tourId, roundNumber);
      if (!data) return res.status(404).send('Tour not found');

      return res.render('admin/tee-times', {
        title: `Tee Times — Round ${roundNumber}`,
        ...data,
        groupSizes,
        isTestTenant: Boolean(req.tenant?.is_test_tenant),
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { return next(err); }
  });

  // Create a new tee group
  router.post('/tours/:tourId/tee-times', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const roundNumber = parseInt(req.body.roundNumber, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
      if (round && round.status !== 'draft') {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${roundNumber}&error=Round+is+not+in+draft+status`);
      }

      const lastGroup = await db('tee_groups')
        .where({ tour_id: tourId, round_number: roundNumber })
        .orderBy('group_number', 'desc')
        .first();
      const groupNumber = (lastGroup ? lastGroup.group_number : 0) + 1;

      await db('tee_groups').insert({
        tour_id: tourId,
        round_number: roundNumber,
        tee_time: req.body.teeTime || '08:00',
        starting_hole: parseInt(req.body.startingHole, 10) || 1,
        tee_location: req.body.teeLocation || null,
        group_number: groupNumber,
        source: 'manual',
      });

      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${roundNumber}&message=Group+added`);
    } catch (err) { return next(err); }
  });

  // Update tee time / starting hole for a group
  router.post('/tours/:tourId/tee-times/:groupId/update', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const groupId = parseInt(req.params.groupId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const group = await db('tee_groups').where({ id: groupId, tour_id: tourId }).first();
      if (!group) return res.status(404).send('Group not found');

      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: group.round_number }).first();
      if (round && round.status !== 'draft') {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${group.round_number}&error=Round+is+not+in+draft+status`);
      }

      await db('tee_groups').where({ id: groupId }).update({
        tee_time: req.body.teeTime || group.tee_time,
        starting_hole: parseInt(req.body.startingHole, 10) || group.starting_hole,
        tee_location: req.body.teeLocation !== undefined ? (req.body.teeLocation || null) : group.tee_location,
      });

      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${group.round_number}&message=Group+updated`);
    } catch (err) { return next(err); }
  });

  // Delete a tee group
  router.post('/tours/:tourId/tee-times/:groupId/delete', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const groupId = parseInt(req.params.groupId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const group = await db('tee_groups').where({ id: groupId, tour_id: tourId }).first();
      if (!group) return res.status(404).send('Group not found');

      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: group.round_number }).first();
      if (round && round.status !== 'draft') {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${group.round_number}&error=Round+is+not+in+draft+status`);
      }

      await db('tee_group_players').where({ tee_group_id: groupId }).delete();
      await db('tee_groups').where({ id: groupId }).delete();

      const remaining = await db('tee_groups')
        .where({ tour_id: tourId, round_number: group.round_number })
        .orderBy('group_number');
      for (let i = 0; i < remaining.length; i += 1) {
        await db('tee_groups').where({ id: remaining[i].id }).update({ group_number: i + 1 });
      }

      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${group.round_number}&message=Group+deleted`);
    } catch (err) { return next(err); }
  });

  // Assign one or more players to a group (removes them from other groups on same round first)
  router.post('/tours/:tourId/tee-times/assign', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const groupId = parseInt(req.body.groupId, 10);
      const userIds = [].concat(req.body.userIds || []).map(Number).filter(Boolean);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const group = await db('tee_groups').where({ id: groupId, tour_id: tourId }).first();
      if (!group) return res.status(404).send('Group not found');

      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: group.round_number }).first();
      if (round && round.status !== 'draft') {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${group.round_number}&error=Round+is+not+in+draft+status`);
      }

      const otherGroupIds = await db('tee_groups')
        .where({ tour_id: tourId, round_number: group.round_number })
        .whereNot({ id: groupId })
        .pluck('id');
      if (otherGroupIds.length) {
        await db('tee_group_players')
          .whereIn('tee_group_id', otherGroupIds)
          .whereIn('user_id', userIds)
          .delete();
      }

      const existingInGroup = await db('tee_group_players')
        .where({ tee_group_id: groupId })
        .orderBy('position')
        .pluck('user_id');
      const existingSet = new Set(existingInGroup.map(Number));
      const newUserIds = userIds.filter((uid) => !existingSet.has(uid));

      if (existingInGroup.length + newUserIds.length > 4) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${group.round_number}&error=Group+is+full+%28maximum+4+players%29`);
      }

      let nextPosition = existingInGroup.length + 1;
      for (const uid of newUserIds) {
        await db('tee_group_players').insert({ tee_group_id: groupId, user_id: uid, position: nextPosition });
        nextPosition += 1;
      }

      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${group.round_number}&message=Players+assigned`);
    } catch (err) { return next(err); }
  });

  // Remove a single player from a group
  router.post('/tours/:tourId/tee-times/:groupId/players/:userId/remove', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const groupId = parseInt(req.params.groupId, 10);
      const userId = parseInt(req.params.userId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const group = await db('tee_groups').where({ id: groupId, tour_id: tourId }).first();
      if (!group) return res.status(404).send('Group not found');

      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: group.round_number }).first();
      if (round && round.status !== 'draft') {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${group.round_number}&error=Round+is+not+in+draft+status`);
      }

      await db('tee_group_players').where({ tee_group_id: groupId, user_id: userId }).delete();

      const remaining = await db('tee_group_players')
        .where({ tee_group_id: groupId })
        .orderBy('position');
      for (let i = 0; i < remaining.length; i += 1) {
        await db('tee_group_players').where({ id: remaining[i].id }).update({ position: i + 1 });
      }

      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${group.round_number}&message=Player+removed`);
    } catch (err) { return next(err); }
  });

  // Generate groups automatically
  router.post('/tours/:tourId/tee-times/generate', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const roundNumber = parseInt(req.body.roundNumber, 10);
      const strategy = String(req.body.strategy || 'distribute');
      const startTime = String(req.body.startTime || '08:00');
      const startingHole = parseInt(req.body.startingHole, 10) || 1;
      const gapMinutes = parseInt(req.body.gapMinutes, 10) || 10;

      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const round = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
      if (round && round.status !== 'draft') {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${roundNumber}&error=Round+is+not+in+draft+status`);
      }

      const activePlayers = await db('event_players as ep')
        .join('users as u', 'u.id', 'ep.user_id')
        .where({ 'ep.tour_id': tourId, 'ep.status': 'active' })
        .select('ep.user_id', 'u.first_name', 'u.last_name');

      if (!activePlayers.length) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${roundNumber}&error=No+active+players`);
      }

      const sizes = groupSizes(activePlayers.length);
      let groupedPlayers;

      if (strategy === 'leaderboard') {
        const snapshots = await db('leaderboard_snapshots')
          .where({ tour_id: tourId })
          .orderBy('created_at', 'desc')
          .first();
        const leaderboard = snapshots
          ? JSON.parse(snapshots.data || '{}').championship || []
          : [];
        groupedPlayers = reverseLeaderboardGroups(activePlayers, leaderboard, sizes);
      } else {
        const allRoundRows = await db('golf_rounds').where({ tour_id: tourId }).orderBy('round_number').select('round_number');
        const priorRounds = allRoundRows.map((r) => r.round_number).filter((rn) => rn !== roundNumber);
        const priorGroups = [];
        for (const rn of priorRounds) {
          const rGroups = await db('tee_groups').where({ tour_id: tourId, round_number: rn }).select('id');
          for (const g of rGroups) {
            const players = await db('tee_group_players').where({ tee_group_id: g.id }).select('user_id');
            priorGroups.push({ players });
          }
        }
        groupedPlayers = distributeGroups(activePlayers, priorGroups, sizes);
      }

      await db('tee_group_players')
        .whereIn(
          'tee_group_id',
          db('tee_groups').where({ tour_id: tourId, round_number: roundNumber }).select('id'),
        )
        .delete();
      await db('tee_groups').where({ tour_id: tourId, round_number: roundNumber }).delete();

      const [startHour, startMin] = startTime.split(':').map(Number);
      let totalMinutes = startHour * 60 + startMin;

      for (let i = 0; i < groupedPlayers.length; i += 1) {
        const h = Math.floor(totalMinutes / 60);
        const m = totalMinutes % 60;
        const teeTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

        const [{ id: newGroupId }] = await db('tee_groups').insert({
          tour_id: tourId,
          round_number: roundNumber,
          tee_time: teeTime,
          starting_hole: startingHole,
          group_number: i + 1,
          source: strategy === 'leaderboard' ? 'day_leaderboard' : 'distributed',
        }).returning('id');

        for (let pos = 0; pos < groupedPlayers[i].length; pos += 1) {
          await db('tee_group_players').insert({
            tee_group_id: newGroupId,
            user_id: groupedPlayers[i][pos].user_id,
            position: pos + 1,
          });
        }

        totalMinutes += gapMinutes;
      }

      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${roundNumber}&message=Groups+generated`);
    } catch (err) { return next(err); }
  });

  // Set or clear a per-round handicap override for a player
  router.post('/tours/:tourId/players/:userId/round-handicap', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const userId = parseInt(req.params.userId, 10);
      const roundNumber = parseInt(req.body.roundNumber, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const raw = req.body.handicapIndex;
      if (raw === '' || raw === undefined) {
        await db('player_day_handicaps').where({ tour_id: tourId, user_id: userId, round_number: roundNumber }).delete();
      } else {
        const idx = parseFloat(raw);
        if (!Number.isFinite(idx)) {
          return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${roundNumber}&error=Invalid+handicap`);
        }
        const existing = await db('player_day_handicaps').where({ tour_id: tourId, user_id: userId, round_number: roundNumber }).first();
        if (existing) {
          await db('player_day_handicaps').where({ id: existing.id }).update({ handicap_index: idx });
        } else {
          await db('player_day_handicaps').insert({ tour_id: tourId, user_id: userId, round_number: roundNumber, handicap_index: idx });
        }
      }

      return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/tee-times`)}?round=${roundNumber}&message=Handicap+updated`);
    } catch (err) { return next(err); }
  });

  // ---------------------------------------------------------------------------
  // Itinerary items
  // ---------------------------------------------------------------------------

  const VALID_ITEM_TYPES = ['accommodation', 'transfer', 'meal', 'activity', 'note', 'flight'];
  const toNull = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;

  function buildItemDetails(type, body) {
    switch (type) {
      case 'accommodation':
        return {
          checkin_notes: toNull(body.detail_checkin_notes),
          checkout_notes: toNull(body.detail_checkout_notes),
        };
      case 'transfer':
        return {
          vehicle: toNull(body.detail_vehicle),
          from: toNull(body.detail_from),
          to: toNull(body.detail_to),
          notes: toNull(body.detail_notes),
        };
      case 'meal':
      case 'activity':
        return { venue: toNull(body.detail_venue) };
      case 'flight':
        return {
          airline: toNull(body.detail_airline),
          flight_number: toNull(body.detail_flight_number),
          departure_airport: toNull(body.detail_departure_airport),
          arrival_airport: toNull(body.detail_arrival_airport),
          terminal: toNull(body.detail_terminal),
          booking_ref: toNull(body.detail_booking_ref),
        };
      default:
        return null;
    }
  }

  router.get('/tours/:tourId/itinerary', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const [items, rounds, teeTimeRows] = await Promise.all([
        db('itinerary_items').where({ tour_id: tourId }).whereNull('user_id').orderBy(['item_date', 'sort_order', 'start_time']),
        db('golf_rounds as gr')
          .join('courses as c', 'gr.course_id', 'c.id')
          .where({ 'gr.tour_id': tourId })
          .orderBy('gr.round_number')
          .select('gr.round_number', 'gr.tour_date', 'gr.calc_type', 'gr.status', 'c.course_name', 'c.tee_name'),
        db('tee_groups')
          .where({ tour_id: tourId })
          .groupBy(['tour_id', 'round_number'])
          .select('round_number', db.raw('MIN(tee_time) as first_tee_time')),
      ]);

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

      res.render('admin/itinerary', {
        title: `Itinerary — ${tour.label}`,
        tour,
        byDate,
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { next(err); }
  });

  router.post('/tours/:tourId/itinerary', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const type = VALID_ITEM_TYPES.includes(req.body.type) ? req.body.type : null;
      if (!type || !req.body.itemDate || !toNull(req.body.title)) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/itinerary`)}?error=Type+date+and+title+are+required`);
      }

      const details = buildItemDetails(type, req.body);
      await db('itinerary_items').insert({
        tour_id: tourId,
        user_id: null,
        type,
        item_date: req.body.itemDate,
        end_date: (type === 'accommodation' || type === 'flight') ? toNull(req.body.endDate) : null,
        title: req.body.title.trim(),
        description: toNull(req.body.description),
        location: toNull(req.body.location),
        start_time: toNull(req.body.startTime),
        end_time: toNull(req.body.endTime),
        details: details ? JSON.stringify(details) : null,
        sort_order: 0,
      });

      res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/itinerary`)}?message=Item+added`);
    } catch (err) { next(err); }
  });

  router.post('/tours/:tourId/itinerary/:itemId(\\d+)', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const itemId = parseInt(req.params.itemId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      const item = await db('itinerary_items').where({ id: itemId, tour_id: tourId }).whereNull('user_id').first();
      if (!item) return res.status(404).send('Item not found');

      const type = VALID_ITEM_TYPES.includes(req.body.type) ? req.body.type : item.type;
      if (!req.body.itemDate || !toNull(req.body.title)) {
        return res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/itinerary`)}?error=Date+and+title+are+required`);
      }

      const details = buildItemDetails(type, req.body);
      await db('itinerary_items').where({ id: itemId }).update({
        type,
        item_date: req.body.itemDate,
        end_date: (type === 'accommodation' || type === 'flight') ? toNull(req.body.endDate) : null,
        title: req.body.title.trim(),
        description: toNull(req.body.description),
        location: toNull(req.body.location),
        start_time: toNull(req.body.startTime),
        end_time: toNull(req.body.endTime),
        details: details ? JSON.stringify(details) : null,
      });

      res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/itinerary`)}?message=Item+updated`);
    } catch (err) { next(err); }
  });

  router.post('/tours/:tourId/itinerary/:itemId(\\d+)/delete', tourGuard, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const itemId = parseInt(req.params.itemId, 10);
      const tour = await db('tours').where({ id: tourId, tenant_id: req.tenant.id }).first();
      if (!tour) return res.status(404).send('Tour not found');

      await db('itinerary_items').where({ id: itemId, tour_id: tourId }).whereNull('user_id').delete();
      res.redirect(`${res.locals.tenantPath(`/admin/tours/${tourId}/itinerary`)}?message=Item+deleted`);
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { adminRouter };
