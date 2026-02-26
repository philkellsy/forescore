'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');

function indexRouter() {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    const role = req.session.user.role;
    if (role === 'admin') return res.redirect('/admin/dashboard');
    return res.redirect('/player/dashboard');
  });

  return router;
}

module.exports = { indexRouter };
