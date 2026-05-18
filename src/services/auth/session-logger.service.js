'use strict';

/**
 * Events:
 *   login_success   — code verified, session established
 *   code_invalid    — user found but code was wrong or expired
 *   no_membership   — code correct but user has no membership in this tenant
 *   logout          — session destroyed
 */
async function logSessionEvent(db, { event, userId, tenantId, req }) {
  try {
    await db('session_logs').insert({
      event,
      user_id:    userId   ?? null,
      tenant_id:  tenantId ?? null,
      ip_address: req?.ip ?? null,
      user_agent: req?.get('user-agent') ?? null,
    });
  } catch (err) {
    // Never let logging break the auth flow
    console.error('[session-log] write_failed', err?.message);
  }
}

module.exports = { logSessionEvent };
