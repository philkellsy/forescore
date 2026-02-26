'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/authorize');
const { ROLES } = require('../config/roles');

function adminRouter(db) {
  const router = express.Router();

  router.get('/dashboard', requireAuth, requireRole([ROLES.ADMIN]), async (req, res) => {
    const [usersCount] = await db('users').count({ total: '*' });
    const [eventsCount] = await db('events').count({ total: '*' });

    const users = await db('users')
      .select('id', 'first_name', 'last_name', 'email', 'role')
      .orderBy('last_name', 'asc');

    return res.render('admin/dashboard', {
      title: 'Admin Dashboard',
      user: req.session.user,
      metrics: {
        users: Number(usersCount.total || 0),
        events: Number(eventsCount.total || 0)
      },
      users
    });
  });

  return router;
}

module.exports = { adminRouter };
