'use strict';

// Runs before migrations on startup. Surfaces the real connection error instead of
// Knex's generic pool timeout message.

let url = process.env.DATABASE_URL;

if (!url && process.env.PGHOST) {
  const { PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE } = process.env;
  url = `postgresql://${PGUSER}:${encodeURIComponent(PGPASSWORD || '')}@${PGHOST}:${PGPORT || 5432}/${PGDATABASE}`;
  console.log('[check-db] Built URL from PG* vars, host:', PGHOST);
}

if (!url) {
  const dbKeys = Object.keys(process.env).filter(k =>
    k.includes('DATABASE') || k.includes('PG') || k.includes('RAILWAY') || k.includes('POSTGRES')
  );
  console.error('[check-db] FATAL: No database config found. Present DB-related vars:', dbKeys.join(', ') || '(none)');
  process.exit(1);
}

const { Client } = require('pg');

let hostname;
try {
  hostname = new URL(url).hostname;
} catch {
  console.error('[check-db] FATAL: DATABASE_URL is not a valid URL:', url.slice(0, 30) + '...');
  process.exit(1);
}

console.log('[check-db] Testing connection to:', hostname);

const ssl = hostname.includes('localhost') || hostname.includes('127.0.0.1') || hostname.includes('.railway.internal')
  ? false
  : { rejectUnauthorized: false };

const client = new Client({ connectionString: url, ssl });

client.connect()
  .then(() => {
    console.log('[check-db] Connection OK');
    return client.end();
  })
  .catch((err) => {
    console.error('[check-db] Connection FAILED:', err.message);
    process.exit(1);
  });
