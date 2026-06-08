'use strict';

exports.up = async function (knex) {
  const hasPrize = await knex.schema.hasColumn('novelty_events', 'prize_amount');
  await knex.schema.alterTable('novelty_events', (t) => {
    t.integer('hole_number').nullable().alter();
    t.integer('course_id').nullable().alter();
    if (!hasPrize) t.integer('prize_amount').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('novelty_events', (t) => {
    t.dropColumn('prize_amount');
    t.integer('hole_number').notNullable().alter();
    t.integer('course_id').notNullable().alter();
  });
};
