'use strict';

const DECIMAL_DEFAULT = '0.00';

exports.up = async function up(knex) {
  const hasEvents = await knex.schema.hasTable('events');
  if (!hasEvents) return;

  const addDecimal = async (column, defaultValue = DECIMAL_DEFAULT) => {
    const exists = await knex.schema.hasColumn('events', column);
    if (!exists) {
      await knex.schema.alterTable('events', (table) => {
        table.decimal(column, 10, 2).notNullable().defaultTo(defaultValue);
      });
    }
  };

  const addPercent = async (column, defaultValue) => {
    const exists = await knex.schema.hasColumn('events', column);
    if (!exists) {
      await knex.schema.alterTable('events', (table) => {
        table.decimal(column, 5, 2).notNullable().defaultTo(defaultValue);
      });
    }
  };

  const addInteger = async (column) => {
    const exists = await knex.schema.hasColumn('events', column);
    if (!exists) {
      await knex.schema.alterTable('events', (table) => {
        table.integer(column);
      });
    }
  };

  await addDecimal('prize_sultans_winner_amount');
  await addDecimal('prize_ambrose_winner_amount');
  await addDecimal('prize_ambrose_second_amount');
  await addDecimal('prize_daily_winner_amount');
  await addDecimal('prize_daily_second_amount');
  await addDecimal('skins_amount_per_player_per_hole', '1.00');
  await addDecimal('prize_ntp_amount');
  await addDecimal('prize_long_drive_amount');

  await addPercent('calcutta_owner_daily_winner_percent', '5.00');
  await addPercent('calcutta_champion_percent', '10.00');
  await addPercent('calcutta_champion_owner_percent', '70.00');
  await addPercent('calcutta_mystery_place_percent', '5.00');

  await addInteger('calcutta_mystery_place');
};

exports.down = async function down(knex) {
  const hasEvents = await knex.schema.hasTable('events');
  if (!hasEvents) return;

  const maybeDrop = async (column) => {
    const exists = await knex.schema.hasColumn('events', column);
    if (exists) {
      await knex.schema.alterTable('events', (table) => {
        table.dropColumn(column);
      });
    }
  };

  await maybeDrop('prize_sultans_winner_amount');
  await maybeDrop('prize_ambrose_winner_amount');
  await maybeDrop('prize_ambrose_second_amount');
  await maybeDrop('prize_daily_winner_amount');
  await maybeDrop('prize_daily_second_amount');
  await maybeDrop('skins_amount_per_player_per_hole');
  await maybeDrop('prize_ntp_amount');
  await maybeDrop('prize_long_drive_amount');
  await maybeDrop('calcutta_owner_daily_winner_percent');
  await maybeDrop('calcutta_champion_percent');
  await maybeDrop('calcutta_champion_owner_percent');
  await maybeDrop('calcutta_mystery_place');
  await maybeDrop('calcutta_mystery_place_percent');
};

