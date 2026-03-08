'use strict';

const fs = require('fs');
const path = require('path');
const { ROLES } = require('./config/roles');

const BASELINE_MIGRATION = '001_initial_schema.js';

function migrationDir() {
  return path.resolve(__dirname, '../migrations');
}

async function ensureDataDir() {
  const dataDir = path.resolve(process.env.DB_FILE ? path.dirname(process.env.DB_FILE) : './data');
  fs.mkdirSync(dataDir, { recursive: true });
}

async function markBaselineIfExistingSchema(db) {
  const hasUsers = await db.schema.hasTable('users');
  if (!hasUsers) return;

  const hasMigrations = await db.schema.hasTable('knex_migrations');
  const hasLock = await db.schema.hasTable('knex_migrations_lock');

  if (!hasMigrations) {
    await db.schema.createTable('knex_migrations', (table) => {
      table.increments('id').primary();
      table.string('name');
      table.integer('batch');
      table.timestamp('migration_time');
    });
  }
  if (!hasLock) {
    await db.schema.createTable('knex_migrations_lock', (table) => {
      table.increments('index').primary();
      table.integer('is_locked');
    });
    await db('knex_migrations_lock').insert({ index: 1, is_locked: 0 });
  } else {
    const lockRow = await db('knex_migrations_lock').where({ index: 1 }).first();
    if (!lockRow) {
      await db('knex_migrations_lock').insert({ index: 1, is_locked: 0 });
    }
  }

  const baseline = await db('knex_migrations').where({ name: BASELINE_MIGRATION }).first();
  if (!baseline) {
    await db('knex_migrations').insert({
      name: BASELINE_MIGRATION,
      batch: 1,
      migration_time: db.fn.now()
    });
  }
}

async function runMigrations(db) {
  await markBaselineIfExistingSchema(db);
  await db.migrate.latest({ directory: migrationDir() });
}

async function seedDefaults(db) {
  const email = 'phil@kellsy.com';
  const existing = await db('users').where({ email }).first();

  if (!existing) {
    await db('users').insert({
      first_name: 'Phil',
      last_name: 'Kells',
      email,
      phone_number: '0404878210',
      role: ROLES.ADMIN,
      is_previous_year_winner: false,
      email_verified_at: db.fn.now()
    });
  }
}

async function cleanupScorecards(db) {
  await db.raw(`
    DELETE FROM scorecards
    WHERE type = 'team'
      AND (team_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM teams t WHERE t.id = scorecards.team_id
      ))
  `);

  await db.raw(`
    DELETE FROM scorecards
    WHERE type = 'individual'
      AND (user_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM event_players ep
        WHERE ep.event_id = scorecards.event_id
          AND ep.user_id = scorecards.user_id
      ))
  `);

  const duplicateIndividuals = await db('scorecards')
    .where({ type: 'individual' })
    .whereNotNull('user_id')
    .select('event_id', 'day', 'user_id')
    .count({ total: '*' })
    .groupBy('event_id', 'day', 'user_id')
    .having('total', '>', 1);

  for (const dup of duplicateIndividuals) {
    const rows = await db('scorecards')
      .where({
        type: 'individual',
        event_id: dup.event_id,
        day: dup.day,
        user_id: dup.user_id
      })
      .orderBy('id', 'asc')
      .select('id');
    const keepId = rows[0]?.id;
    const removeIds = rows.slice(1).map((r) => r.id);
    if (keepId && removeIds.length) {
      await db('scorecards').whereIn('id', removeIds).del();
    }
  }

  const duplicateTeams = await db('scorecards')
    .where({ type: 'team' })
    .whereNotNull('team_id')
    .select('event_id', 'day', 'team_id')
    .count({ total: '*' })
    .groupBy('event_id', 'day', 'team_id')
    .having('total', '>', 1);

  for (const dup of duplicateTeams) {
    const rows = await db('scorecards')
      .where({
        type: 'team',
        event_id: dup.event_id,
        day: dup.day,
        team_id: dup.team_id
      })
      .orderBy('id', 'asc')
      .select('id');
    const keepId = rows[0]?.id;
    const removeIds = rows.slice(1).map((r) => r.id);
    if (keepId && removeIds.length) {
      await db('scorecards').whereIn('id', removeIds).del();
    }
  }
}

async function bootstrap(db) {
  await ensureDataDir();
  await runMigrations(db);
  await cleanupScorecards(db);
  await seedDefaults(db);
}

module.exports = {
  bootstrap
};
