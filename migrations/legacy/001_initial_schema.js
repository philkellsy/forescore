'use strict';

/**
 * Initial schema baseline for Legends scoring app.
 * This migration is treated as the canonical schema for fresh installs.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('users', (table) => {
    table.increments('id').primary();
    table.string('first_name').notNullable();
    table.string('last_name').notNullable();
    table.string('email').notNullable().unique();
    table.string('phone_number');
    table.boolean('is_previous_winner').notNullable().defaultTo(false);
    table.string('role').notNullable().defaultTo('player');
    table.boolean('is_previous_year_winner').notNullable().defaultTo(false);
    table.timestamp('email_verified_at');
    table.timestamps(true, true);
  });

  await knex.schema.createTable('events', (table) => {
    table.increments('id').primary();
    table.integer('year').notNullable().unique();
    table.string('location').notNullable();
    table.date('start_date').notNullable();
    table.date('end_date').notNullable();
    table.boolean('is_active').notNullable().defaultTo(false);
    table.timestamp('leaderboard_dirty_at');
    table.timestamps(true, true);
  });

  await knex.schema.createTable('event_players', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('status').notNullable().defaultTo('active');
    table.boolean('is_previous_year_winner').notNullable().defaultTo(false);
    table.unique(['event_id', 'user_id']);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('courses', (table) => {
    table.increments('id').primary();
    table.string('course_name').notNullable();
    table.string('tee_name').notNullable();
    table.unique(['course_name', 'tee_name']);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('holes', (table) => {
    table.increments('id').primary();
    table.integer('course_id').notNullable().references('id').inTable('courses').onDelete('CASCADE');
    table.integer('hole_number').notNullable();
    table.integer('par').notNullable();
    table.integer('length_meters');
    table.integer('stroke_index_primary').notNullable();
    table.integer('stroke_index_secondary').notNullable();
    table.unique(['course_id', 'hole_number']);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('player_handicaps', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.decimal('playing_handicap', 5, 2).notNullable();
    table.unique(['event_id', 'user_id']);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('tee_groups', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('day').notNullable();
    table.time('tee_time').notNullable();
    table.string('tee_location');
    table.integer('starting_hole').notNullable().defaultTo(1);
    table.integer('group_number').notNullable();
    table.string('source').notNullable().defaultTo('manual');
    table.timestamps(true, true);
  });

  await knex.schema.createTable('tee_group_players', (table) => {
    table.increments('id').primary();
    table.integer('tee_group_id').notNullable().references('id').inTable('tee_groups').onDelete('CASCADE');
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.integer('position').notNullable();
    table.unique(['tee_group_id', 'user_id']);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('ambrose_groups', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('day').notNullable().defaultTo(1);
    table.integer('group_number').notNullable();
    table.time('tee_time').notNullable();
    table.string('tee_location').notNullable();
    table.integer('starting_hole').notNullable().defaultTo(1);
    table.unique(['event_id', 'day', 'group_number']);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('teams', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('day').notNullable();
    table.string('competition_type').notNullable();
    table.string('name').notNullable();
    table.integer('ambrose_group_id');
    table.timestamps(true, true);
  });

  await knex.schema.createTable('team_members', (table) => {
    table.increments('id').primary();
    table.integer('team_id').notNullable().references('id').inTable('teams').onDelete('CASCADE');
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.boolean('is_dual_assigned').notNullable().defaultTo(false);
    table.unique(['team_id', 'user_id']);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('scorecards', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('day').notNullable();
    table.string('type').notNullable();
    table.integer('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.integer('team_id').references('id').inTable('teams').onDelete('CASCADE');
    table.string('status').notNullable().defaultTo('draft');
    table.timestamps(true, true);
  });

  await knex.schema.createTable('scorecard_holes', (table) => {
    table.increments('id').primary();
    table.integer('scorecard_id').notNullable().references('id').inTable('scorecards').onDelete('CASCADE');
    table.integer('hole_number').notNullable();
    table.integer('gross_score').notNullable();
    table.integer('stableford_points');
    table.integer('owner_user_id').references('id').inTable('users').onDelete('SET NULL');
    table.unique(['scorecard_id', 'hole_number']);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('scorecard_edit_logs', (table) => {
    table.increments('id').primary();
    table.integer('scorecard_id').notNullable().references('id').inTable('scorecards').onDelete('CASCADE');
    table.integer('hole_number').notNullable();
    table.integer('previous_gross_score');
    table.integer('previous_stableford_points');
    table.integer('new_gross_score');
    table.integer('new_stableford_points');
    table.integer('editor_user_id').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['scorecard_id', 'created_at'], 'idx_scorecard_edit_logs_scorecard_created');
  });

  await knex.schema.createTable('calcutta_auctions', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('auctioned_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.integer('buyer_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.integer('owner_user_id').references('id').inTable('users').onDelete('SET NULL');
    table.decimal('auction_bid_amount', 10, 2).notNullable().defaultTo(0);
    table.integer('draw_order').notNullable();
    table.unique(['event_id', 'auctioned_user_id']);
    table.unique(['event_id', 'draw_order']);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('event_day_statuses', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('day').notNullable();
    table.string('status').notNullable().defaultTo('draft');
    table.string('calc_type').notNullable().defaultTo('stableford');
    table.boolean('leaderboard_published').notNullable().defaultTo(false);
    table.integer('course_id').notNullable().references('id').inTable('courses');
    table.unique(['event_id', 'day']);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('leaderboard_snapshots', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('day').notNullable();
    table.string('competition_type').notNullable();
    table.text('payload_json').notNullable();
    table.timestamp('calculated_at').notNullable();
    table.timestamps(true, true);
  });

  await knex.schema.createTable('skins_holes', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('day').notNullable();
    table.integer('hole_number').notNullable();
    table.string('participant_type').notNullable();
    table.integer('winning_participant_id');
    table.integer('winning_gross');
    table.integer('winning_stableford');
    table.decimal('base_pot_amount', 10, 2).notNullable().defaultTo(0);
    table.decimal('carry_in_amount', 10, 2).notNullable().defaultTo(0);
    table.decimal('total_pot_amount', 10, 2).notNullable().defaultTo(0);
    table.string('status').notNullable();
    table.unique(['event_id', 'day', 'hole_number']);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('skins_carry', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('from_day').notNullable();
    table.integer('from_hole').notNullable();
    table.integer('to_day');
    table.integer('to_hole');
    table.decimal('carry_amount', 10, 2).notNullable().defaultTo(0);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('ambrose_drives', (table) => {
    table.increments('id').primary();
    table.integer('scorecard_id').notNullable().references('id').inTable('scorecards').onDelete('CASCADE');
    table.integer('hole_number').notNullable();
    table.integer('drive_taken_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.unique(['scorecard_id', 'hole_number']);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('login_tokens', (table) => {
    table.increments('id').primary();
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('token_hash').notNullable().unique();
    table.timestamp('expires_at').notNullable();
    table.timestamp('used_at');
    table.string('ip');
    table.string('user_agent');
    table.timestamps(true, true);
  });

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_scorecards_individual
    ON scorecards (event_id, day, user_id)
    WHERE type = 'individual' AND user_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_scorecards_team
    ON scorecards (event_id, day, team_id)
    WHERE type = 'team' AND team_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_ambrose_team_name_in_group
    ON teams (event_id, day, competition_type, ambrose_group_id, name)
    WHERE competition_type = 'ambrose' AND ambrose_group_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('login_tokens');
  await knex.schema.dropTableIfExists('ambrose_drives');
  await knex.schema.dropTableIfExists('skins_carry');
  await knex.schema.dropTableIfExists('skins_holes');
  await knex.schema.dropTableIfExists('leaderboard_snapshots');
  await knex.schema.dropTableIfExists('event_day_statuses');
  await knex.schema.dropTableIfExists('calcutta_auctions');
  await knex.schema.dropTableIfExists('scorecard_holes');
  await knex.schema.dropTableIfExists('scorecard_edit_logs');
  await knex.schema.dropTableIfExists('scorecards');
  await knex.schema.dropTableIfExists('team_members');
  await knex.schema.dropTableIfExists('teams');
  await knex.schema.dropTableIfExists('ambrose_groups');
  await knex.schema.dropTableIfExists('tee_group_players');
  await knex.schema.dropTableIfExists('tee_groups');
  await knex.schema.dropTableIfExists('player_handicaps');
  await knex.schema.dropTableIfExists('holes');
  await knex.schema.dropTableIfExists('courses');
  await knex.schema.dropTableIfExists('event_players');
  await knex.schema.dropTableIfExists('events');
  await knex.schema.dropTableIfExists('users');
};
