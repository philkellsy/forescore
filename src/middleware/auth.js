'use strict';

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/auth/login');
  }
  return next();
}

module.exports = { requireAuth };
