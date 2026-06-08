'use strict';

exports.up = async function(knex) {
  const groups = await knex('tee_groups').select('id');
  for (const group of groups) {
    const players = await knex('tee_group_players')
      .where({ tee_group_id: group.id })
      .orderByRaw('position ASC, id ASC')
      .select('id');
    for (let i = 0; i < players.length; i++) {
      await knex('tee_group_players').where({ id: players[i].id }).update({ position: i + 1 });
    }
  }
};

exports.down = function() {};
