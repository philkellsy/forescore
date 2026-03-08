'use strict';

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('scorecard_edit_logs');
  if (hasTable) return;

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
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('scorecard_edit_logs');
  if (!hasTable) return;
  await knex.schema.dropTable('scorecard_edit_logs');
};
