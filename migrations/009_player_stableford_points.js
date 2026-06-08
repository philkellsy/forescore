'use strict';

exports.up = async function(knex) {
  await knex.schema.alterTable('scorecard_holes', (t) => {
    t.smallint('player_stableford_points').nullable();
  });
};

exports.down = async function(knex) {
  await knex.schema.alterTable('scorecard_holes', (t) => {
    t.dropColumn('player_stableford_points');
  });
};
