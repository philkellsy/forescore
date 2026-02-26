'use strict';

const db = require('./db/knex');
const { bootstrap } = require('./bootstrap');
const { createApp } = require('./app');
const { port } = require('./config/env');

async function start() {
  await bootstrap(db);
  const app = createApp({ db });

  app.listen(port, () => {
    console.log(`Legends app listening on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
