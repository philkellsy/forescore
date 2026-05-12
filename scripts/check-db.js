'use strict';

// Runs before migrations on startup. Surfaces the real connection error instead of
// Knex's generic pool timeout message.

// Print which DB/Railway env vars are present (names only, no values)
const dbKeys = Object.keys(process.env).filter(k =>
  k.includes('DATABASE') || k.includes('PG') || k.includes('RAILWAY') || k.includes('POSTGRES')
);
console.log('[check-db] DB-related env vars present:', dbKeys.join(', ') || '(none)');

const url = process.env.DATABASE_URL;

if (!url) {
  console.error('[check-db] FATAL: DATABASE_URL is not set. Set it in Railway → app service → Variables.');
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
