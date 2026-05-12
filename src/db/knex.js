'use strict';

const knex = require('knex');
const { types } = require('pg');
const config = require('../../knexfile');

// Return date columns (OID 1082) as plain ISO strings rather than local-timezone
// Date objects. Without this, "2026-05-12" stored → 2026-05-11T14:00:00Z returned
// on a UTC+10 server, shifting every date one day back.
types.setTypeParser(1082, (val) => val);

const env = process.env.NODE_ENV || 'development';

module.exports = knex(config[env] || config.development);
