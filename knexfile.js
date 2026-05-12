'use strict';

const path = require('path');

const migrationsDir = path.join(__dirname, 'migrations');

const base = {
  client: 'pg',
  migrations: {
    directory: migrationsDir,
    // Exclude the legacy SQLite migration archive
    loadExtensions: ['.js'],
    schemaName: 'public',
  },
};

module.exports = {
  development: {
    ...base,
    connection: process.env.DATABASE_URL || 'postgresql://localhost:5432/forescore_dev',
  },

  test: {
    ...base,
    connection: process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/forescore_test',
  },

  production: {
    ...base,
    connection: {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    },
    pool: { min: 2, max: 10 },
  },
};
