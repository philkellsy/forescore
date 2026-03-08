'use strict';

exports.up = async function up(knex) {
  const hasCourses = await knex.schema.hasTable('courses');
  if (!hasCourses) return;
  const hasLegacyTmp = await knex.schema.hasTable('courses_legacy_tmp');

  const hasEventId = await knex.schema.hasColumn('courses', 'event_id');
  if (!hasEventId) {
    if (hasLegacyTmp) {
      // Clean up stale temp table from a previously interrupted migration.
      await knex.schema.dropTable('courses_legacy_tmp');
    }
    return;
  }

  // Backfill per-day course assignment from legacy event-linked courses where missing.
  const legacyRows = await knex('courses')
    .whereNotNull('event_id')
    .select('id', 'event_id')
    .orderBy('id', 'asc');
  const firstCourseByEvent = new Map();
  for (const row of legacyRows) {
    const eventId = Number(row.event_id);
    if (!firstCourseByEvent.has(eventId)) firstCourseByEvent.set(eventId, Number(row.id));
  }
  for (const [eventId, courseId] of firstCourseByEvent.entries()) {
    await knex('event_day_statuses')
      .where({ event_id: eventId })
      .whereNull('course_id')
      .update({ course_id: courseId, updated_at: knex.fn.now() });
  }

  // Rebuild table without event_id (SQLite drop-column compatibility).
  if (hasLegacyTmp) {
    // Stale temp table from a prior failed run; remove before rename.
    await knex.schema.dropTable('courses_legacy_tmp');
  }
  await knex.raw('PRAGMA foreign_keys = OFF');
  await knex.schema.renameTable('courses', 'courses_legacy_tmp');
  await knex.schema.createTable('courses', (table) => {
    table.increments('id').primary();
    table.string('course_name').notNullable();
    table.string('tee_name').notNullable();
    table.unique(['course_name', 'tee_name']);
    table.timestamps(true, true);
  });
  await knex.raw(`
    INSERT INTO courses (id, course_name, tee_name, created_at, updated_at)
    SELECT id, course_name, tee_name, created_at, updated_at
    FROM courses_legacy_tmp
  `);
  await knex.schema.dropTable('courses_legacy_tmp');
  await knex.raw('PRAGMA foreign_keys = ON');
};

exports.down = async function down(knex) {
  const hasCourses = await knex.schema.hasTable('courses');
  if (!hasCourses) return;
  const hasNoEventTmp = await knex.schema.hasTable('courses_no_event_tmp');
  const hasEventId = await knex.schema.hasColumn('courses', 'event_id');
  if (hasEventId) {
    if (hasNoEventTmp) {
      await knex.schema.dropTable('courses_no_event_tmp');
    }
    return;
  }

  if (hasNoEventTmp) {
    await knex.schema.dropTable('courses_no_event_tmp');
  }
  await knex.raw('PRAGMA foreign_keys = OFF');
  await knex.schema.renameTable('courses', 'courses_no_event_tmp');
  await knex.schema.createTable('courses', (table) => {
    table.increments('id').primary();
    table.integer('event_id').references('id').inTable('events').onDelete('CASCADE');
    table.string('course_name').notNullable();
    table.string('tee_name').notNullable();
    table.unique(['course_name', 'tee_name']);
    table.timestamps(true, true);
  });
  await knex.raw(`
    INSERT INTO courses (id, event_id, course_name, tee_name, created_at, updated_at)
    SELECT id, NULL, course_name, tee_name, created_at, updated_at
    FROM courses_no_event_tmp
  `);
  await knex.schema.dropTable('courses_no_event_tmp');
  await knex.raw('PRAGMA foreign_keys = ON');
};
