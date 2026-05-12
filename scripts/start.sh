#!/bin/sh
set -e

echo "[start] Step 1: checking DB connection..."
node scripts/check-db.js

echo "[start] Step 2: running migrations..."
node_modules/.bin/knex migrate:latest --knexfile knexfile.js

echo "[start] Step 3: starting server..."
exec node src/server.js
