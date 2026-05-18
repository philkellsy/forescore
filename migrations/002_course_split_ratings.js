'use strict';

exports.up = async function (knex) {
  await knex.schema.alterTable('courses', (t) => {
    t.boolean('supports_split_ratings').notNullable().defaultTo(false);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('courses', (t) => {
    t.dropColumn('supports_split_ratings');
  });
};
