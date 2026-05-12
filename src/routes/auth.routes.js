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

function authRouter(db) {
  const router = express.Router({ mergeParams: true });

  async function establishSession(req, res, next, user, options = {}) {
    return new Promise((resolve, reject) => {
      req.session.regenerate((regenError) => {
        if (regenError) {
          next(regenError);
          return reject(regenError);
        }

        req.session.user = {
          id: user.id,
          firstName: user.first_name,
          lastName: user.last_name,
          email: user.email,
          isSuperAdmin: Boolean(user.is_super_admin),
        };

        const rememberMe = Boolean(options.rememberMe);
        if (rememberMe) {
          req.session.cookie.maxAge = req.session.cookie.originalMaxAge;
          req.session.cookie.expires = new Date(Date.now() + Number(req.session.cookie.maxAge || 0));
        } else {
          req.session.cookie.expires = false;
          req.session.cookie.maxAge = null;
        }

        return req.session.save((saveError) => {
          if (saveError) {
            next(saveError);
            return reject(saveError);
          }
          return resolve();
        });
      });
    });
  }

  function renderLogin(res, payload = {}) {
    return res.render('auth/login', {
      title: 'Sign In',
      tenant: res.locals.tenant || null,
      user: null,
      error: null,
      info: null,
      sent: false,
      codeStage: false,
      lookupValue: '',
      rememberMe: true,
      resendAvailableAtMs: 0,
      codeExpiryMinutes: LOGIN_CODE_EXPIRY_MINUTES,
      codeLength: LOGIN_CODE_LENGTH,
      ...payload,
    });
  }

  function setLookupCookie(res, lookupValue) {
    res.cookie(LOGIN_LOOKUP_COOKIE, String(lookupValue || ''), {
      maxAge: LOGIN_LOOKUP_COOKIE_MAX_AGE_MS,
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      path: '/',
    });
  }

  function clearLookupCookie(res) {
    res.clearCookie(LOGIN_LOOKUP_COOKIE, { sameSite: 'lax', secure: isProd, path: '/' });
  }

  function resendAtMs(seconds) {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    return Date.now() + safe * 1000;
  }

  async function sendCodeForLookup(req, rawLookup) {
    const lookup = normalizeLookup(rawLookup);
    if (!lookup) return { ok: false, error: 'Email or mobile is required.', lookup: '' };

    const user = await findUserByLookup(db, lookup);
    if (user) {
      const remaining = await getResendRemainingSeconds(db, Number(user.id));
      if (remaining > 0) return { ok: false, throttleSeconds: remaining, lookup };

      const { code } = await createLoginCode(db, user.id, req.ip, req.get('user-agent'));
      try {
        await sendLoginCode(user.email, code);
      } catch (sendError) {
        console.error('[auth] login_code_send_failed', {
          userId: Number(user.id),
          error: sendError?.message || String(sendError),
        });
      }
    }

    req.session.pendingLoginLookup = lookup;
    return { ok: true, lookup };
  }

  router.get('/login', (req, res) => {
    if (req.session?.user) {
      return res.redirect(req.session.user.isSuperAdmin ? '/' : `/${req.tenant.slug}/`);
    }
    const rememberedLookup = normalizeLookup(req.cookies?.[LOGIN_LOOKUP_COOKIE] || '');
    return renderLogin(res, {
      lookupValue: rememberedLookup,
      rememberMe: Boolean(rememberedLookup),
      info: req.query.info ? String(req.query.info) : null,
    });
  });

  router.post('/send-code', authLimiter, async (req, res, next) => {
    try {
      const rememberMe = String(req.body.rememberMe || '').toLowerCase() === 'on';
      const result = await sendCodeForLookup(req, req.body.lookup);

      if (!result.ok) {
        if (result.throttleSeconds > 0) {
          return renderLogin(res.status(200), {
            codeStage: true,
            sent: true,
            lookupValue: result.lookup,
            rememberMe,
            error: `Please wait ${result.throttleSeconds}s before requesting another code.`,
            resendAvailableAtMs: resendAtMs(result.throttleSeconds),
          });
        }
        return renderLogin(res.status(400), {
          rememberMe,
          error: result.error || 'Unable to send code.',
        });
      }

      req.session.pendingRememberMe = rememberMe;
      if (rememberMe && result.lookup) {
        setLookupCookie(res, result.lookup);
      } else {
        clearLookupCookie(res);
      }

      return renderLogin(res, {
        codeStage: true,
        sent: true,
        lookupValue: result.lookup,
        rememberMe,
        info: 'If a matching account exists, a sign-in code has been sent.',
        resendAvailableAtMs: resendAtMs(LOGIN_CODE_RESEND_SECONDS),
      });
    } catch (error) {
      console.error('[auth] send_code_failed', { error: error?.message || String(error) });
      return renderLogin(res, {
        codeStage: true,
        sent: true,
        lookupValue: normalizeLookup(req.body.lookup),
        info: 'If a matching account exists, a sign-in code has been sent.',
        resendAvailableAtMs: resendAtMs(LOGIN_CODE_RESEND_SECONDS),
      });
    }
  });

  router.post('/resend-code', authLimiter, async (req, res, next) => {
    try {
      const lookupInput = req.body.lookup || req.session?.pendingLoginLookup || '';
      const result = await sendCodeForLookup(req, lookupInput);

      if (!result.ok) {
        if (result.throttleSeconds > 0) {
          return renderLogin(res.status(200), {
            codeStage: true,
            sent: true,
            lookupValue: result.lookup,
            error: `Please wait ${result.throttleSeconds}s before requesting another code.`,
            resendAvailableAtMs: resendAtMs(result.throttleSeconds),
          });
        }
        return renderLogin(res.status(400), {
          codeStage: true,
          sent: true,
          lookupValue: normalizeLookup(lookupInput),
          error: result.error || 'Email or mobile is required.',
        });
      }

      return renderLogin(res, {
        codeStage: true,
        sent: true,
        lookupValue: result.lookup,
        info: 'If a matching account exists, a new sign-in code has been sent.',
        resendAvailableAtMs: resendAtMs(LOGIN_CODE_RESEND_SECONDS),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/verify-code', authLimiter, async (req, res, next) => {
    try {
      const lookupInput = req.body.lookup || req.session?.pendingLoginLookup || '';
      const lookup = normalizeLookup(lookupInput);
      const code = sanitizeCode(req.body.code);
      const rememberMe = req.session?.pendingRememberMe !== false;

      if (!lookup) {
        return renderLogin(res.status(400), { error: 'Email or mobile is required.' });
      }
      if (code.length !== LOGIN_CODE_LENGTH) {
        return renderLogin(res.status(400), {
          codeStage: true,
          sent: true,
          lookupValue: lookup,
          rememberMe,
          error: `Enter a ${LOGIN_CODE_LENGTH}-digit code.`,
        });
      }

      const user = await findUserByLookup(db, lookup);
      if (!user) {
        return renderLogin(res.status(400), {
          codeStage: true,
          sent: true,
          lookupValue: lookup,
          rememberMe,
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
          rememberMe,
          error: 'Invalid or expired code.',
          resendAvailableAtMs: resendAtMs(remaining),
        });
      }

      // Super admins can log in to any tenant — no membership check required
      if (user.is_super_admin) {
        await establishSession(req, res, next, user, { rememberMe });
        req.session.pendingLoginLookup = null;
        req.session.pendingRememberMe = null;
        return res.redirect('/');
      }

      // Regular users must have a membership in this tenant
      const membership = await db('tenant_memberships')
        .where({ tenant_id: req.tenant.id, user_id: user.id })
        .first();

      if (!membership) {
        return renderLogin(res.status(403), {
          error: `You don't have access to ${req.tenant.name}. Contact your tour administrator.`,
        });
      }

      await establishSession(req, res, next, user, { rememberMe });
      req.session.pendingLoginLookup = null;
      req.session.pendingRememberMe = null;
      return res.redirect(`/${req.tenant.slug}/`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/logout', (req, res) => {
    const slug = req.tenant?.slug;
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.clearCookie(LOGIN_LOOKUP_COOKIE, { sameSite: 'lax', secure: isProd, path: '/' });
      res.redirect(slug ? `/${slug}/auth/login` : '/');
    });
  });

  return router;
}

module.exports = { authRouter };
