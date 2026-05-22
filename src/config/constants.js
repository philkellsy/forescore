'use strict';

const SESSION_COOKIE_NAME = 'connect.sid';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_CODE_EXPIRY_MINUTES = 15;
const LOGIN_CODE_LENGTH = 6;
const LOGIN_CODE_RESEND_SECONDS = 30;

// Tenant used for cross-tenant testing — sees all courses system-wide.
const TEST_TENANT_ID = 1;

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  LOGIN_CODE_EXPIRY_MINUTES,
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_RESEND_SECONDS,
  TEST_TENANT_ID,
};
