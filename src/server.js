'use strict';

require('dotenv').config();

const db = require('./db/knex');
const { bootstrap } = require('./bootstrap');
const { createApp } = require('./app');
const { port, brevoApiKey } = require('./config/env');

async function checkBrevoOnStartup() {
  if (!brevoApiKey) {
    console.log('[startup] brevo_check_skipped (BREVO_API_KEY not set)');
    return;
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/account', {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'api-key': brevoApiKey
      }
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[startup] brevo_check_failed', {
        status: res.status,
        body: body.slice(0, 300)
      });
      return;
    }

    const payload = await res.json().catch(() => ({}));
    console.log('[startup] brevo_check_ok', {
      email: payload?.email || null,
      firstName: payload?.firstName || null,
      lastName: payload?.lastName || null
    });
  } catch (error) {
    console.error('[startup] brevo_check_error', {
      error: error?.message || String(error)
    });
  }
}

const SESSION_LOG_RETENTION_DAYS = 180;
const SESSION_LOG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function cleanupSessionLogs() {
  try {
    const deleted = await db('session_logs')
      .where('created_at', '<', db.raw(`NOW() - INTERVAL '${SESSION_LOG_RETENTION_DAYS} days'`))
      .delete();
    if (deleted > 0) {
      console.log('[session-log] cleanup_complete', { deleted, retentionDays: SESSION_LOG_RETENTION_DAYS });
    }
  } catch (err) {
    console.error('[session-log] cleanup_failed', err?.message);
  }
}

async function start() {
  await bootstrap(db);
  const app = createApp({ db });

  app.listen(port, () => {
    console.log(`ForeScore listening on http://localhost:${port}`);
    checkBrevoOnStartup();
    cleanupSessionLogs();
    setInterval(cleanupSessionLogs, SESSION_LOG_CLEANUP_INTERVAL_MS);
  });
}

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
