'use strict';

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('event_day_statuses');
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn('event_day_statuses', 'calc_type');
  if (!hasColumn) {
    await knex.schema.alterTable('event_day_statuses', (table) => {
      table.string('calc_type').notNullable().defaultTo('stableford');
    });
  }

  await knex('event_day_statuses').where({ day: 1 }).update({ calc_type: 'ambrose_nett' });
  await knex('event_day_statuses').whereIn('day', [2, 3, 4]).update({ calc_type: 'stableford' });
  await knex('event_day_statuses').whereNull('calc_type').update({ calc_type: 'stableford' });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('event_day_statuses');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('event_day_statuses', 'calc_type');
  if (!hasColumn) return;

  await knex.schema.alterTable('event_day_statuses', (table) => {
    table.dropColumn('calc_type');
  });
};

