'use strict';

const path = require('path');

const dbFile = process.env.DB_FILE || path.join(__dirname, 'data', 'legends.sqlite');

module.exports = {
  development: {
    client: 'sqlite3',
    connection: {
      filename: dbFile
    },
    migrations: {
      directory: path.join(__dirname, 'migrations')
    },
    useNullAsDefault: true,
    pool: {
      afterCreate: (conn, done) => {
        conn.run('PRAGMA foreign_keys = ON;', done);
      }
    }
  }
};
