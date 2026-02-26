'use strict';

function requireRole(allowedRoles) {
  return function roleMiddleware(req, res, next) {
    const role = req.session?.user?.role;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).render('auth/forbidden', {
        title: 'Forbidden',
        user: req.session?.user || null
      });
    }
    return next();
  };
}

module.exports = { requireRole };
