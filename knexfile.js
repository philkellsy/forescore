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
  return url && !url.includes('localhost') && !url.includes('127.0.0.1');
}

function pgConnection(url) {
  if (isRemote(url)) {
    return { connectionString: url, ssl: { rejectUnauthorized: false } };
  }
  return url;
}

const devUrl = process.env.DATABASE_URL || 'postgresql://localhost:5432/forescore_dev';
const testUrl = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/forescore_test';

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
    connection: pgConnection(process.env.DATABASE_URL),
    pool: { min: 2, max: 10 },
  },
};
