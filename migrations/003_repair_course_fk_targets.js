'use strict';

function normalizeRawRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.[0])) return raw[0];
  if (Array.isArray(raw?.rows)) return raw.rows;
  return [];
}

async function foreignKeyTargets(knex, tableName) {
  const raw = await knex.raw(`PRAGMA foreign_key_list(${tableName})`);
  const rows = normalizeRawRows(raw);
  return new Set(rows.map((r) => String(r.table || '')));
}

exports.up = async function up(knex) {
  const hasCourses = await knex.schema.hasTable('courses');
  const hasHoles = await knex.schema.hasTable('holes');
  const hasDayStatuses = await knex.schema.hasTable('event_day_statuses');
  if (!hasCourses || !hasHoles || !hasDayStatuses) return;

  const holeTargets = await foreignKeyTargets(knex, 'holes');
  const dayTargets = await foreignKeyTargets(knex, 'event_day_statuses');
  const needsHolesFix = holeTargets.has('courses_legacy_tmp');
  const needsDayFix = dayTargets.has('courses_legacy_tmp');

  if (!needsHolesFix && !needsDayFix) return;

  await knex.raw('PRAGMA foreign_keys = OFF');

  if (needsHolesFix) {
    await knex.raw('DROP INDEX IF EXISTS holes_course_id_hole_number_unique');
    if (await knex.schema.hasTable('holes_fk_fix_tmp')) {
      await knex.schema.dropTable('holes_fk_fix_tmp');
    }
    await knex.schema.renameTable('holes', 'holes_fk_fix_tmp');
    await knex.schema.createTable('holes', (table) => {
      table.increments('id').primary();
      table.integer('course_id').notNullable().references('id').inTable('courses').onDelete('CASCADE');
      table.integer('hole_number').notNullable();
      table.integer('par').notNullable();
      table.integer('length_meters');
      table.integer('stroke_index_primary').notNullable();
      table.integer('stroke_index_secondary').notNullable();
      table.unique(['course_id', 'hole_number']);
      table.timestamps(true, true);
    });
    await knex.raw(`
      INSERT INTO holes (id, course_id, hole_number, par, length_meters, stroke_index_primary, stroke_index_secondary, created_at, updated_at)
      SELECT id, course_id, hole_number, par, length_meters, stroke_index_primary, stroke_index_secondary, created_at, updated_at
      FROM holes_fk_fix_tmp
    `);
    await knex.schema.dropTable('holes_fk_fix_tmp');
  }

  if (needsDayFix) {
    await knex.raw('DROP INDEX IF EXISTS event_day_statuses_event_id_day_unique');
    if (await knex.schema.hasTable('event_day_statuses_fk_fix_tmp')) {
      await knex.schema.dropTable('event_day_statuses_fk_fix_tmp');
    }
    await knex.schema.renameTable('event_day_statuses', 'event_day_statuses_fk_fix_tmp');
    await knex.schema.createTable('event_day_statuses', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.integer('day').notNullable();
      table.string('status').notNullable().defaultTo('draft');
      table.boolean('leaderboard_published').notNullable().defaultTo(false);
      table.integer('course_id').references('id').inTable('courses').onDelete('SET NULL');
      table.unique(['event_id', 'day']);
      table.timestamps(true, true);
    });
    await knex.raw(`
      INSERT INTO event_day_statuses (id, event_id, day, status, leaderboard_published, course_id, created_at, updated_at)
      SELECT id, event_id, day, status, leaderboard_published, course_id, created_at, updated_at
      FROM event_day_statuses_fk_fix_tmp
    `);
    await knex.schema.dropTable('event_day_statuses_fk_fix_tmp');
  }

  await knex.raw('PRAGMA foreign_keys = ON');
};

exports.down = async function down() {
  // No-op: this migration only repairs FK targets for broken states.
};
