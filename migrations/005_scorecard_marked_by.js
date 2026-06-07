'use strict';

exports.up = async function up(knex) {
  await knex.schema.alterTable('scorecards', (table) => {
    table.integer('marked_by_user_id').nullable().references('id').inTable('users');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('scorecards', (table) => {
    table.dropColumn('marked_by_user_id');
  });
};
