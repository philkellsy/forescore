'use strict';

const path = require('path');

const migrationsDir = path.join(__dirname, 'migrations');

const base = {
  client: 'pg',
  migrations: {
    directory: migrationsDir,
    loadExtensions: ['.js'],
    schemaName: 'public',
  },
};

function isRemote(url) {
  // Railway's private network (*.railway.internal) is VPC-encrypted — no app-level SSL needed.
  // Only add SSL for public/external connections.
  if (!url) return false;
  if (url.includes('localhost') || url.includes('127.0.0.1')) return false;
  if (url.includes('.railway.internal')) return false;
  return true;
}

function pgConnection(url) {
  if (isRemote(url)) {
    return { connectionString: url, ssl: { rejectUnauthorized: false } };
  }
  return url;
}

function buildUrl(urlEnvVar, pgHostEnvVar, fallback) {
  if (process.env[urlEnvVar]) return process.env[urlEnvVar];
  if (process.env[pgHostEnvVar]) {
    const { PGUSER, PGPASSWORD, PGDATABASE, PGPORT } = process.env;
    return `postgresql://${PGUSER}:${encodeURIComponent(PGPASSWORD || '')}@${process.env[pgHostEnvVar]}:${PGPORT || 5432}/${PGDATABASE}`;
  }
  return fallback;
}

const devUrl = buildUrl('DATABASE_URL', 'PGHOST', 'postgresql://localhost:5432/forescore_dev');
const testUrl = buildUrl('TEST_DATABASE_URL', null, 'postgresql://localhost:5432/forescore_test');
const prodUrl = buildUrl('DATABASE_URL', 'PGHOST', null);

module.exports = {
  development: {
    ...base,
    connection: pgConnection(devUrl),
  },

  test: {
    ...base,
    connection: pgConnection(testUrl),
  },

  production: {
    ...base,
    connection: pgConnection(prodUrl),
    pool: {
      min: 2,
      max: 15,
      idleTimeoutMillis: 60000,
      reapIntervalMillis: 5000,
    },
  },
};
