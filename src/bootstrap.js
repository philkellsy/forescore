'use strict';

const fs = require('fs');
const path = require('path');
const { ROLES } = require('./config/roles');

async function ensureSchema(db) {
  const dataDir = path.resolve(process.env.DB_FILE ? path.dirname(process.env.DB_FILE) : './data');
  fs.mkdirSync(dataDir, { recursive: true });

  if (!(await db.schema.hasTable('users'))) {
    await db.schema.createTable('users', (table) => {
      table.increments('id').primary();
      table.string('first_name').notNullable();
      table.string('last_name').notNullable();
      table.string('email').notNullable().unique();
      table.string('phone_number');
      table.string('role').notNullable().defaultTo(ROLES.PLAYER);
      table.boolean('is_previous_year_winner').notNullable().defaultTo(false);
      table.timestamp('email_verified_at');
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('events'))) {
    await db.schema.createTable('events', (table) => {
      table.increments('id').primary();
      table.integer('year').notNullable().unique();
      table.string('location').notNullable();
      table.date('start_date').notNullable();
      table.date('end_date').notNullable();
      table.boolean('is_active').notNullable().defaultTo(false);
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('event_players'))) {
    await db.schema.createTable('event_players', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.string('status').notNullable().defaultTo('active');
      table.unique(['event_id', 'user_id']);
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('courses'))) {
    await db.schema.createTable('courses', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.string('course_name').notNullable();
      table.string('tee_name').notNullable();
      table.unique(['event_id', 'course_name', 'tee_name']);
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('holes'))) {
    await db.schema.createTable('holes', (table) => {
      table.increments('id').primary();
      table.integer('course_id').notNullable().references('id').inTable('courses').onDelete('CASCADE');
      table.integer('hole_number').notNullable();
      table.integer('par').notNullable();
      table.integer('stroke_index').notNullable();
      table.unique(['course_id', 'hole_number']);
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('player_handicaps'))) {
    await db.schema.createTable('player_handicaps', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.decimal('playing_handicap', 5, 2).notNullable();
      table.unique(['event_id', 'user_id']);
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('tee_groups'))) {
    await db.schema.createTable('tee_groups', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.integer('day').notNullable();
      table.time('tee_time').notNullable();
      table.string('tee_location');
      table.integer('group_number').notNullable();
      table.string('source').notNullable().defaultTo('manual');
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('tee_group_players'))) {
    await db.schema.createTable('tee_group_players', (table) => {
      table.increments('id').primary();
      table.integer('tee_group_id').notNullable().references('id').inTable('tee_groups').onDelete('CASCADE');
      table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.integer('position').notNullable();
      table.unique(['tee_group_id', 'user_id']);
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('teams'))) {
    await db.schema.createTable('teams', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.integer('day').notNullable();
      table.string('competition_type').notNullable();
      table.string('name').notNullable();
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('team_members'))) {
    await db.schema.createTable('team_members', (table) => {
      table.increments('id').primary();
      table.integer('team_id').notNullable().references('id').inTable('teams').onDelete('CASCADE');
      table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.boolean('is_dual_assigned').notNullable().defaultTo(false);
      table.unique(['team_id', 'user_id']);
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('scorecards'))) {
    await db.schema.createTable('scorecards', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.integer('day').notNullable();
      table.string('type').notNullable();
      table.integer('user_id').references('id').inTable('users').onDelete('CASCADE');
      table.integer('team_id').references('id').inTable('teams').onDelete('CASCADE');
      table.string('status').notNullable().defaultTo('draft');
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('scorecard_holes'))) {
    await db.schema.createTable('scorecard_holes', (table) => {
      table.increments('id').primary();
      table.integer('scorecard_id').notNullable().references('id').inTable('scorecards').onDelete('CASCADE');
      table.integer('hole_number').notNullable();
      table.integer('gross_score').notNullable();
      table.integer('stableford_points');
      table.unique(['scorecard_id', 'hole_number']);
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('calcutta_auctions'))) {
    await db.schema.createTable('calcutta_auctions', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.integer('auctioned_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.integer('owner_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.decimal('auction_bid_amount', 10, 2).notNullable();
      table.integer('draw_order').notNullable();
      table.unique(['event_id', 'auctioned_user_id']);
      table.unique(['event_id', 'draw_order']);
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('leaderboard_snapshots'))) {
    await db.schema.createTable('leaderboard_snapshots', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.integer('day').notNullable();
      table.string('competition_type').notNullable();
      table.text('payload_json').notNullable();
      table.timestamp('calculated_at').notNullable();
      table.timestamps(true, true);
    });
  }

  if (!(await db.schema.hasTable('login_tokens'))) {
    await db.schema.createTable('login_tokens', (table) => {
      table.increments('id').primary();
      table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.string('token_hash').notNullable().unique();
      table.timestamp('expires_at').notNullable();
      table.timestamp('used_at');
      table.string('ip');
      table.string('user_agent');
      table.timestamps(true, true);
    });
  }
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

async function bootstrap(db) {
  await ensureSchema(db);
  await seedDefaults(db);
}

module.exports = {
  bootstrap
};
