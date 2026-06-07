'use strict';

exports.up = async function (knex) {
  await knex.schema.alterTable('tenants', (t) => {
    t.boolean('is_test_tenant').notNullable().defaultTo(false);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('tenants', (t) => {
    t.dropColumn('is_test_tenant');
  });
};
