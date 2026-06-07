'use strict';

exports.up = async function up(knex) {
  await knex.schema.alterTable('scorecard_holes', (table) => {
    // Allow gross_score to be null so a player-advisory row can exist before the marker enters.
    table.integer('gross_score').nullable().alter();
    table.integer('player_gross_score').nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('scorecard_holes', (table) => {
    table.dropColumn('player_gross_score');
    table.integer('gross_score').notNullable().alter();
  });
};
