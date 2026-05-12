'use strict';

const { ROLE_HIERARCHY } = require('../config/roles');

// Require one of the listed roles exactly
function requireRole(...roles) {
  return function roleMiddleware(req, res, next) {
    if (!req.tenantMembership || !roles.includes(req.tenantMembership.role)) {
      return res.status(403).render('auth/forbidden', {
        title: 'Forbidden',
        user: req.session?.user || null,
        tenant: req.tenant || null,
      });
    }
    return next();
  };
}

// Require at least minRole in the hierarchy (e.g. 'admin' also allows 'owner')
function requireMinRole(minRole) {
  const minIndex = ROLE_HIERARCHY.indexOf(minRole);
  return function roleMiddleware(req, res, next) {
    const roleIndex = ROLE_HIERARCHY.indexOf(req.tenantMembership?.role);
    if (!req.tenantMembership || roleIndex < minIndex) {
      return res.status(403).render('auth/forbidden', {
        title: 'Forbidden',
        user: req.session?.user || null,
        tenant: req.tenant || null,
      });
    }
    return next();
  };
}

module.exports = { requireRole, requireMinRole };
