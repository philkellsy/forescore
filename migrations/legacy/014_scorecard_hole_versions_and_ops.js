'use strict';

async function up(knex) {
  const hasTable = await knex.schema.hasTable('scorecard_holes');
  if (!hasTable) return;

  const hasVersion = await knex.schema.hasColumn('scorecard_holes', 'version');
  if (!hasVersion) {
    await knex.schema.alterTable('scorecard_holes', (table) => {
      table.integer('version').notNullable().defaultTo(1);
    });
  }

  const hasOpId = await knex.schema.hasColumn('scorecard_holes', 'op_id');
  if (!hasOpId) {
    await knex.schema.alterTable('scorecard_holes', (table) => {
      table.string('op_id');
    });
  }

  // Best-effort backfill for legacy rows where version might be null.
  await knex('scorecard_holes').whereNull('version').update({ version: 1 });

  // SQLite cannot reliably introspect index names across old states; guard with try/catch.
  try {
    await knex.schema.alterTable('scorecard_holes', (table) => {
      table.unique(['op_id'], 'scorecard_holes_op_id_unique');
    });
  } catch (_error) {
    // no-op: index likely already exists
  }
}

async function down(knex) {
  const hasTable = await knex.schema.hasTable('scorecard_holes');
  if (!hasTable) return;

  try {
    await knex.schema.alterTable('scorecard_holes', (table) => {
      table.dropUnique(['op_id'], 'scorecard_holes_op_id_unique');
    });
  } catch (_error) {
    // no-op
  }

  const hasOpId = await knex.schema.hasColumn('scorecard_holes', 'op_id');
  if (hasOpId) {
    await knex.schema.alterTable('scorecard_holes', (table) => {
      table.dropColumn('op_id');
    });
  }

  const hasVersion = await knex.schema.hasColumn('scorecard_holes', 'version');
  if (hasVersion) {
    await knex.schema.alterTable('scorecard_holes', (table) => {
      table.dropColumn('version');
    });
  }
}

module.exports = { up, down };

