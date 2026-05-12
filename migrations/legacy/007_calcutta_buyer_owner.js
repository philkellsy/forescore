'use strict';

exports.up = async function up(knex) {
  const hasMain = await knex.schema.hasTable('calcutta_auctions');
  const hasTmp = await knex.schema.hasTable('calcutta_auctions_tmp_007');
  if (!hasMain && !hasTmp) return;

  if (hasMain) {
    const hasBuyer = await knex.schema.hasColumn('calcutta_auctions', 'buyer_user_id');
    const hasOwner = await knex.schema.hasColumn('calcutta_auctions', 'owner_user_id');
    const hasBid = await knex.schema.hasColumn('calcutta_auctions', 'auction_bid_amount');
    if (hasBuyer && hasOwner && hasBid && !hasTmp) return;
  }

  await knex.raw('PRAGMA foreign_keys = OFF');
  // SQLite index names are global; failed prior runs can leave these behind.
  await knex.raw('DROP INDEX IF EXISTS calcutta_auctions_event_id_auctioned_user_id_unique');
  await knex.raw('DROP INDEX IF EXISTS calcutta_auctions_event_id_draw_order_unique');

  let sourceTable = 'calcutta_auctions_tmp_007';
  if (!hasTmp) {
    await knex.schema.renameTable('calcutta_auctions', 'calcutta_auctions_tmp_007');
  } else if (hasMain) {
    // Partial failed run may have recreated calcutta_auctions already.
    await knex.schema.dropTable('calcutta_auctions');
  }

  await knex.schema.createTable('calcutta_auctions', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('auctioned_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.integer('buyer_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.integer('owner_user_id').references('id').inTable('users').onDelete('SET NULL');
    table.decimal('auction_bid_amount', 10, 2).notNullable().defaultTo(0);
    table.integer('draw_order').notNullable();
    table.unique(['event_id', 'auctioned_user_id']);
    table.unique(['event_id', 'draw_order']);
    table.timestamps(true, true);
  });

  await knex.raw(`
    INSERT INTO calcutta_auctions (
      id, event_id, auctioned_user_id, buyer_user_id, owner_user_id, auction_bid_amount, draw_order, created_at, updated_at
    )
    SELECT
      id,
      event_id,
      auctioned_user_id,
      COALESCE(owner_user_id, auctioned_user_id) AS buyer_user_id,
      owner_user_id,
      COALESCE(auction_bid_amount, 0) AS auction_bid_amount,
      draw_order,
      created_at,
      updated_at
    FROM ${sourceTable}
  `);

  await knex.schema.dropTable(sourceTable);
  await knex.raw('PRAGMA foreign_keys = ON');
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('calcutta_auctions');
  if (!hasTable) return;

  await knex.raw('PRAGMA foreign_keys = OFF');
  await knex.schema.renameTable('calcutta_auctions', 'calcutta_auctions_tmp_007_down');
  await knex.schema.createTable('calcutta_auctions', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('auctioned_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.integer('owner_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.decimal('auction_bid_amount', 10, 2).notNullable().defaultTo(0);
    table.integer('draw_order').notNullable();
    table.unique(['event_id', 'auctioned_user_id']);
    table.unique(['event_id', 'draw_order']);
    table.timestamps(true, true);
  });

  await knex.raw(`
    INSERT INTO calcutta_auctions (
      id, event_id, auctioned_user_id, owner_user_id, auction_bid_amount, draw_order, created_at, updated_at
    )
    SELECT
      id,
      event_id,
      auctioned_user_id,
      COALESCE(owner_user_id, buyer_user_id),
      COALESCE(auction_bid_amount, 0),
      draw_order,
      created_at,
      updated_at
    FROM calcutta_auctions_tmp_007_down
  `);

  await knex.schema.dropTable('calcutta_auctions_tmp_007_down');
  await knex.raw('PRAGMA foreign_keys = ON');
};
