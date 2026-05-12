'use strict';

const express = require('express');
const { authLimiter } = require('../middleware/rate-limit');
const {
  LOGIN_CODE_RESEND_SECONDS,
  sanitizeCode,
  normalizeLookup,
  findUserByLookup,
  getResendRemainingSeconds,
  createLoginCode,
  consumeLoginCode,
} = require('../services/auth/login-code.service');
const { sendLoginCode } = require('../services/auth/mailer.service');
const { isProd } = require('../config/env');
const { LOGIN_CODE_EXPIRY_MINUTES, LOGIN_CODE_LENGTH } = require('../config/constants');

const LOGIN_LOOKUP_COOKIE = 'fs_login_lookup';
const LOGIN_LOOKUP_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function requireSuperAdmin(req, res, next) {
  if (!req.session?.user?.isSuperAdmin) {
    return res.status(403).render('auth/error', {
      title: 'Forbidden',
      error: 'Super admin access required.',
      user: req.session?.user || null,
    });
  }
  return next();
}

function superAdminRouter(db) {
  const router = express.Router();

  function renderLogin(res, payload = {}) {
    return res.render('super-admin/login', {
      title: 'Super Admin Sign In',
      user: null,
      tenant: null,
      error: null,
      info: null,
      sent: false,
      codeStage: false,
      lookupValue: '',
      resendAvailableAtMs: 0,
      codeExpiryMinutes: LOGIN_CODE_EXPIRY_MINUTES,
      codeLength: LOGIN_CODE_LENGTH,
      ...payload,
    });
  }

  function resendAtMs(seconds) {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    return Date.now() + safe * 1000;
  }

  function setLookupCookie(res, lookup) {
    res.cookie(LOGIN_LOOKUP_COOKIE, String(lookup || ''), {
      maxAge: LOGIN_LOOKUP_COOKIE_MAX_AGE_MS,
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      path: '/',
    });
  }

  // -------------------------------------------------------------------------
  // Super admin global login
  // -------------------------------------------------------------------------
  router.get('/auth/login', (req, res) => {
    if (req.session?.user?.isSuperAdmin) return res.redirect('/');
    const rememberedLookup = normalizeLookup(req.cookies?.[LOGIN_LOOKUP_COOKIE] || '');
    return renderLogin(res, { lookupValue: rememberedLookup });
  });

  router.post('/auth/send-code', authLimiter, async (req, res, next) => {
    try {
      const lookup = normalizeLookup(req.body.lookup);
      if (!lookup) return renderLogin(res.status(400), { error: 'Email or mobile is required.' });

      const user = await findUserByLookup(db, lookup);

      // Non-super-admin tenant member — redirect them to their tenant login
      if (user && !user.is_super_admin) {
        const membership = await db('tenant_memberships as m')
          .join('tenants as t', 't.id', 'm.tenant_id')
          .where({ 'm.user_id': user.id })
          .select('t.slug', 't.name')
          .orderBy('m.joined_at')
          .first();
        if (membership) {
          return res.redirect(`/${membership.slug}/auth/login?info=${encodeURIComponent(`Sign in to ${membership.name}`)}`);
        }
        return renderLogin(res.status(400), {
          error: 'This page is for super admins only. Contact your tour administrator for the correct sign-in link.',
        });
      }

      if (user && user.is_super_admin) {
        const remaining = await getResendRemainingSeconds(db, Number(user.id));
        if (remaining > 0) {
          return renderLogin(res.status(200), {
            codeStage: true,
            sent: true,
            lookupValue: lookup,
            error: `Please wait ${remaining}s before requesting another code.`,
            resendAvailableAtMs: resendAtMs(remaining),
          });
        }
        const { code } = await createLoginCode(db, user.id, req.ip, req.get('user-agent'));
        try {
          await sendLoginCode(user.email, code);
        } catch (sendErr) {
          console.error('[super-admin-auth] send_failed', sendErr?.message);
        }
        setLookupCookie(res, lookup);
      }

      req.session.pendingLoginLookup = lookup;
      return renderLogin(res, {
        codeStage: true,
        sent: true,
        lookupValue: lookup,
        info: 'If a matching super admin account exists, a sign-in code has been sent.',
        resendAvailableAtMs: resendAtMs(LOGIN_CODE_RESEND_SECONDS),
      });
    } catch (err) { return next(err); }
  });

  router.post('/auth/verify-code', authLimiter, async (req, res, next) => {
    try {
      const lookupInput = req.body.lookup || req.session?.pendingLoginLookup || '';
      const lookup = normalizeLookup(lookupInput);
      const code = sanitizeCode(req.body.code);

      if (!lookup || code.length !== LOGIN_CODE_LENGTH) {
        return renderLogin(res.status(400), {
          codeStage: true,
          sent: true,
          lookupValue: lookup,
          error: `Enter a ${LOGIN_CODE_LENGTH}-digit code.`,
        });
      }

      const user = await findUserByLookup(db, lookup);
      if (!user || !user.is_super_admin) {
        return renderLogin(res.status(400), {
          codeStage: true,
          sent: true,
          lookupValue: lookup,
          error: 'Invalid or expired code.',
        });
      }

      const codeRow = await consumeLoginCode(db, Number(user.id), code);
      if (!codeRow) {
        const remaining = await getResendRemainingSeconds(db, Number(user.id));
        return renderLogin(res.status(400), {
          codeStage: true,
          sent: true,
          lookupValue: lookup,
          error: 'Invalid or expired code.',
          resendAvailableAtMs: resendAtMs(remaining),
        });
      }

      await new Promise((resolve, reject) => {
        req.session.regenerate((err) => { if (err) return reject(err); return resolve(); });
      });

      req.session.user = {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        isSuperAdmin: true,
      };
      req.session.pendingLoginLookup = null;

      await new Promise((resolve, reject) => {
        req.session.save((err) => { if (err) return reject(err); return resolve(); });
      });

      return res.redirect('/');
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Root — routes every visitor to the right place
  // -------------------------------------------------------------------------
  router.get('/', async (req, res, next) => {
    try {
      if (!req.session?.user) {
        return res.redirect('/auth/login');
      }

      if (!req.session.user.isSuperAdmin) {
        const membership = await db('tenant_memberships as m')
          .join('tenants as t', 't.id', 'm.tenant_id')
          .where({ 'm.user_id': req.session.user.id })
          .select('t.slug')
          .orderBy('m.joined_at')
          .first();
        if (membership) return res.redirect(`/${membership.slug}/`);
        return res.status(400).send('No tour membership found. Contact your administrator.');
      }

      const tenants = await db('tenants').orderBy('name');
      const counts = await db('tenant_memberships')
        .select('tenant_id')
        .count('* as member_count')
        .groupBy('tenant_id');
      const countByTenant = new Map(counts.map((r) => [r.tenant_id, Number(r.member_count)]));

      return res.render('super-admin/tenants', {
        title: 'All Tenants',
        user: req.session.user,
        tenants: tenants.map((t) => ({ ...t, memberCount: countByTenant.get(t.id) || 0 })),
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { return next(err); }
  });

  // Email existence check for tenant-new form
  router.get('/tenants/check-email', requireSuperAdmin, async (req, res, next) => {
    try {
      const email = String(req.query.email || '').trim().toLowerCase();
      if (!email.includes('@')) return res.json({ found: false });
      const user = await db('users').where({ email }).first();
      if (user) {
        return res.json({ found: true, name: `${user.first_name} ${user.last_name}`.trim() });
      }
      return res.json({ found: false });
    } catch (err) { return next(err); }
  });

  function renderNewTenant(res, payload = {}) {
    return res.render('super-admin/tenant-new', {
      title: 'New Tour',
      user: null,
      error: null,
      fields: {},
      ...payload,
    });
  }

  router.get('/tenants/new', requireSuperAdmin, (req, res) => {
    return renderNewTenant(res);
  });

  router.post('/tenants', requireSuperAdmin, async (req, res, next) => {
    try {
      const name = String(req.body.name || '').trim();
      const normalizedSlug = String(req.body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const plan = req.body.plan || 'free';
      const adminEmail = String(req.body.adminEmail || '').trim().toLowerCase();
      const adminFirstName = String(req.body.adminFirstName || '').trim();
      const adminLastName = String(req.body.adminLastName || '').trim();
      const adminRole = ['owner', 'admin'].includes(req.body.adminRole) ? req.body.adminRole : 'owner';

      const fields = { name, slug: normalizedSlug, plan, adminEmail, adminFirstName, adminLastName, adminRole };

      if (!name || !normalizedSlug) {
        return renderNewTenant(res.status(400), { error: 'Tour name and slug are required.', fields });
      }
      if (!adminEmail) {
        return renderNewTenant(res.status(400), { error: 'Admin email is required.', fields });
      }

      const slugTaken = await db('tenants').where({ slug: normalizedSlug }).first();
      if (slugTaken) {
        return renderNewTenant(res.status(400), { error: 'That slug is already taken.', fields });
      }

      const existingCheck = await db('users').where({ email: adminEmail }).first();
      if (!existingCheck && (!adminFirstName || !adminLastName)) {
        return renderNewTenant(res.status(400), {
          error: 'First and last name are required when adding a new user.',
          fields,
        });
      }

      const tenant = await db.transaction(async (trx) => {
        const [newTenant] = await trx('tenants').insert({
          name,
          slug: normalizedSlug,
          plan,
          subscription_status: 'active',
          settings: JSON.stringify({}),
        }).returning('*');

        let user = await trx('users').where({ email: adminEmail }).first();
        if (!user) {
          [user] = await trx('users').insert({
            first_name: adminFirstName,
            last_name: adminLastName,
            email: adminEmail,
            email_verified_at: trx.fn.now(),
          }).returning('*');
        }

        await trx('tenant_memberships').insert({
          tenant_id: newTenant.id,
          user_id: user.id,
          role: adminRole,
          invited_by_user_id: req.session.user.id,
        });

        return newTenant;
      });

      return res.redirect(`/${tenant.slug}/admin?message=Tour+created`);
    } catch (err) {
      if (err.isValidation) {
        return renderNewTenant(res.status(400), { error: err.message, fields: err.fields });
      }
      return next(err);
    }
  });

  router.post('/tenants/:tenantId/delete', requireSuperAdmin, async (req, res, next) => {
    try {
      const tenantId = parseInt(req.params.tenantId, 10);
      const tenant = await db('tenants').where({ id: tenantId }).first();
      if (!tenant) return res.redirect('/?error=Tenant+not+found');

      await db('tenants').where({ id: tenantId }).delete();
      return res.redirect(`/?message=${encodeURIComponent(`"${tenant.name}" deleted`)}`);
    } catch (err) { return next(err); }
  });

  // -------------------------------------------------------------------------
  // Tours — all tours across all tenants, payment management
  // -------------------------------------------------------------------------
  router.get('/tours', requireSuperAdmin, async (req, res, next) => {
    try {
      const tours = await db('tours as t')
        .join('tenants as tn', 'tn.id', 't.tenant_id')
        .select(
          't.id', 't.label', 't.year', 't.status', 't.is_paid', 't.paid_at',
          'tn.id as tenant_id', 'tn.name as tenant_name', 'tn.slug as tenant_slug',
        )
        .orderBy([{ column: 'tn.name' }, { column: 't.year', order: 'desc' }]);

      return res.render('super-admin/tours', {
        title: 'All Tours',
        user: req.session.user,
        tours,
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/mark-paid', requireSuperAdmin, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const tour = await db('tours').where({ id: tourId }).first();
      if (!tour) return res.redirect('/tours?error=Tour+not+found');

      await db('tours').where({ id: tourId }).update({ is_paid: true, paid_at: db.fn.now() });
      return res.redirect(`/tours?message=${encodeURIComponent(`"${tour.label}" approved for activation`)}`);
    } catch (err) { return next(err); }
  });

  router.post('/tours/:tourId/mark-unpaid', requireSuperAdmin, async (req, res, next) => {
    try {
      const tourId = parseInt(req.params.tourId, 10);
      const tour = await db('tours').where({ id: tourId }).first();
      if (!tour) return res.redirect('/tours?error=Tour+not+found');

      if (tour.status === 'active') {
        return res.redirect(`/tours?error=${encodeURIComponent('Cannot revoke payment on an active tour. Complete or draft it first.')}`);
      }

      await db('tours').where({ id: tourId }).update({ is_paid: false, paid_at: null });
      return res.redirect(`/tours?message=${encodeURIComponent(`Payment approval removed from "${tour.label}"`)}`);
    } catch (err) { return next(err); }
  });

  return router;
}

module.exports = { superAdminRouter };
