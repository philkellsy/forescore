'use strict';

function tenantMiddleware(db) {
  return async function resolveTenant(req, res, next) {
    try {
      const slug = req.params.tenantSlug;
      const tenant = await db('tenants').where({ slug }).first();

      if (!tenant) {
        return res.status(404).send('Tour not found');
      }

      req.tenant = tenant;
      res.locals.tenant = tenant;
      res.locals.tenantPath = (p) => `/${tenant.slug}${p}`;
      res.locals.hasTourAdminAccess = false;

      // If authenticated, attach this tenant's membership so role checks are synchronous
      if (req.session?.user) {
        const membership = await db('tenant_memberships')
          .where({ tenant_id: tenant.id, user_id: req.session.user.id })
          .first();

        if (membership) {
          req.tenantMembership = membership;
        } else if (req.session.user.isSuperAdmin) {
          // Synthesize an owner membership — super admins have full access to every tenant
          req.tenantMembership = {
            role: 'owner',
            tenant_id: tenant.id,
            user_id: req.session.user.id,
            isSynthetic: true,
          };
        } else {
          req.tenantMembership = null;
        }

        res.locals.tenantMembership = req.tenantMembership;
        res.locals.isSuperAdmin = Boolean(req.session.user.isSuperAdmin);

        // Check if user has any tour admin access in this tenant (for nav)
        const role = req.tenantMembership?.role;
        const isTenantAdmin = role === 'admin' || role === 'owner';
        if (!isTenantAdmin && !req.session.user.isSuperAdmin && req.tenantMembership) {
          const tourAdminRow = await db('tour_admins as ta')
            .join('tours as t', 't.id', 'ta.tour_id')
            .where({ 't.tenant_id': tenant.id, 'ta.user_id': req.session.user.id })
            .first();
          res.locals.hasTourAdminAccess = Boolean(tourAdminRow);
        } else {
          res.locals.hasTourAdminAccess = false;
        }
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { tenantMiddleware };
