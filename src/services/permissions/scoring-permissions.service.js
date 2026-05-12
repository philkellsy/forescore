'use strict';

// Role is on tenant_memberships, not users. Pass req.tenantMembership.role.
function canEditAllScores(role) {
  return role === 'owner' || role === 'admin' || role === 'scorer';
}

module.exports = { canEditAllScores };
