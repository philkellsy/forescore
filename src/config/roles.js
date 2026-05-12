'use strict';

const ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  SCORER: 'scorer',
  PLAYER: 'player',
};

// Ordered least → most privileged; used for requireMinRole checks
const ROLE_HIERARCHY = [ROLES.PLAYER, ROLES.SCORER, ROLES.ADMIN, ROLES.OWNER];

module.exports = { ROLES, ROLE_HIERARCHY };
