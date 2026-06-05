'use strict';

exports.up = async function up(knex) {
  await knex.schema.alterTable('golf_rounds', (table) => {
    table.boolean('leaderboard_show_in_progress').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('golf_rounds', (table) => {
    table.dropColumn('leaderboard_show_in_progress');
  });
};
