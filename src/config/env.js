'use strict';

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 5050),
  baseUrl: process.env.BASE_URL || 'http://localhost:5050',
  sessionSecret: process.env.SESSION_SECRET || 'development-secret-change-me',
  dbFile: process.env.DB_FILE || './data/legends.sqlite'
};
