'use strict';

const SESSION_COOKIE_NAME = 'connect.sid';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAGIC_LINK_EXPIRY_MINUTES = 15;

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  MAGIC_LINK_EXPIRY_MINUTES
};
