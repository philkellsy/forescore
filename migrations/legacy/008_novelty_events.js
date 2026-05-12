'use strict';

exports.up = async function up(knex) {
  const hasEvents = await knex.schema.hasTable('novelty_events');
  if (!hasEvents) {
    await knex.schema.createTable('novelty_events', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.integer('day').notNullable();
      table.integer('course_id').notNullable().references('id').inTable('courses').onDelete('CASCADE');
      table.integer('hole_number').notNullable();
      table.string('novelty_type', 32).notNullable();
      table.string('label', 120).notNullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.index(['event_id', 'day'], 'idx_novelty_events_event_day');
    });
  }

  const hasResults = await knex.schema.hasTable('novelty_results');
  if (!hasResults) {
    await knex.schema.createTable('novelty_results', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.integer('day').notNullable();
      table.integer('novelty_event_id').notNullable().references('id').inTable('novelty_events').onDelete('CASCADE');
      table.integer('winner_user_id').references('id').inTable('users').onDelete('SET NULL');
      table.integer('winner_team_id').references('id').inTable('teams').onDelete('SET NULL');
      table.integer('is_no_winner').notNullable().defaultTo(0);
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.unique(['novelty_event_id'], 'ux_novelty_results_novelty_event');
      table.index(['event_id', 'day'], 'idx_novelty_results_event_day');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('novelty_results')) {
    await knex.schema.dropTable('novelty_results');
  }
  if (await knex.schema.hasTable('novelty_events')) {
    await knex.schema.dropTable('novelty_events');
  }
};
