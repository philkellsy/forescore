'use strict';

function requireAuth(req, res, next) {
  if (!req.session?.user) {
    const slug = req.tenant?.slug || req.params.tenantSlug;
    return res.redirect(`/${slug}/auth/login`);
  }
  return next();
}

module.exports = { requireAuth };
