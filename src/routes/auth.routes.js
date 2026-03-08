'use strict';

const express = require('express');
const { authLimiter } = require('../middleware/rate-limit');
const { createLoginToken, consumeLoginToken } = require('../services/auth/magic-link.service');
const { sendMagicLink } = require('../services/auth/mailer.service');
const { baseUrl } = require('../config/env');

function authRouter(db) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    if (req.session?.user) return res.redirect('/');
    return res.render('auth/login', { title: 'Sign In', sent: false, error: null, user: null });
  });

  router.post('/magic-link', authLimiter, async (req, res, next) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase();
      if (!email) {
        return res.status(400).render('auth/login', { title: 'Sign In', sent: false, error: 'Email is required.', user: null });
      }

      const user = await db('users').where({ email }).first();
      if (user) {
        const { token } = await createLoginToken(db, user.id, req.ip, req.get('user-agent'));
        const link = `${baseUrl}/auth/verify?token=${token}`;
        try {
          await sendMagicLink(email, link);
        } catch (sendError) {
          // Keep response generic for security; delivery failures are server-side only.
          console.error('[auth] magic_link_send_failed', {
            userId: Number(user.id),
            error: sendError?.message || String(sendError)
          });
        }
      }

      return res.render('auth/login', { title: 'Sign In', sent: true, user: null, error: null });
    } catch (error) {
      // Keep response generic for security/UX and avoid client-side failures.
      console.error('[auth] magic_link_request_failed', {
        error: error?.message || String(error)
      });
      return res.render('auth/login', { title: 'Sign In', sent: true, user: null, error: null });
    }
  });

  router.get('/verify', async (req, res, next) => {
    try {
      const token = String(req.query.token || '');
      if (!token) return res.status(400).render('auth/login', { title: 'Sign In', sent: false, error: 'Invalid login link.', user: null });

      const tokenRow = await consumeLoginToken(db, token);
      if (!tokenRow) {
        return res.status(400).render('auth/login', { title: 'Sign In', sent: false, error: 'Login link expired or already used.', user: null });
      }

      const user = await db('users').where({ id: tokenRow.user_id }).first();
      if (!user) return res.status(404).render('auth/login', { title: 'Sign In', sent: false, error: 'User not found.', user: null });

      req.session.regenerate((regenError) => {
        if (regenError) return next(regenError);

        req.session.user = {
          id: user.id,
          firstName: user.first_name,
          lastName: user.last_name,
          email: user.email,
          role: user.role
        };

        return req.session.save((saveError) => {
          if (saveError) return next(saveError);
          return res.redirect('/');
        });
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.redirect('/auth/login');
    });
  });

  return router;
}

module.exports = { authRouter };
