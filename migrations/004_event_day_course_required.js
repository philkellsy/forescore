'use strict';

const DAYS = [1, 2, 3, 4];

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('event_day_statuses');
  if (!hasTable) return;
  const hasCourseId = await knex.schema.hasColumn('event_day_statuses', 'course_id');
  if (!hasCourseId) return;

  const firstCourse = await knex('courses').orderBy('id', 'asc').first();
  const fallbackCourseId = firstCourse ? Number(firstCourse.id) : null;
  const dayStatusCountRow = await knex('event_day_statuses').count({ total: '*' }).first();
  const dayStatusCount = Number(dayStatusCountRow?.total || 0);
  if (!fallbackCourseId && dayStatusCount > 0) {
    throw new Error('Cannot enforce non-null event_day_statuses.course_id: no courses found');
  }

  const events = await knex('events').select('id');
  for (const event of events) {
    const eventId = Number(event.id);
    for (const day of DAYS) {
      const row = await knex('event_day_statuses').where({ event_id: eventId, day }).first();
      if (!row) {
        if (!fallbackCourseId) continue;
        await knex('event_day_statuses').insert({
          event_id: eventId,
          day,
          status: 'draft',
          leaderboard_published: 0,
          course_id: fallbackCourseId
        });
      } else if (row.course_id == null) {
        if (!fallbackCourseId) {
          throw new Error('Cannot enforce non-null event_day_statuses.course_id: no courses found');
        }
        await knex('event_day_statuses')
          .where({ id: row.id })
          .update({ course_id: fallbackCourseId, updated_at: knex.fn.now() });
      }
    }
  }

  await knex.raw('PRAGMA foreign_keys = OFF');
  await knex.raw('DROP INDEX IF EXISTS event_day_statuses_event_id_day_unique');
  if (await knex.schema.hasTable('event_day_statuses_notnull_tmp')) {
    await knex.schema.dropTable('event_day_statuses_notnull_tmp');
  }
  await knex.schema.renameTable('event_day_statuses', 'event_day_statuses_notnull_tmp');
  await knex.schema.createTable('event_day_statuses', (table) => {
    table.increments('id').primary();
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    table.integer('day').notNullable();
    table.string('status').notNullable().defaultTo('draft');
    table.boolean('leaderboard_published').notNullable().defaultTo(false);
    table.integer('course_id').notNullable().references('id').inTable('courses');
    table.unique(['event_id', 'day']);
    table.timestamps(true, true);
  });
  await knex.raw(`
    INSERT INTO event_day_statuses (id, event_id, day, status, leaderboard_published, course_id, created_at, updated_at)
    SELECT id, event_id, day, status, leaderboard_published, course_id, created_at, updated_at
    FROM event_day_statuses_notnull_tmp
  `);
  await knex.schema.dropTable('event_day_statuses_notnull_tmp');
  await knex.raw('PRAGMA foreign_keys = ON');
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('event_day_statuses');
  if (!hasTable) return;

  await knex.raw('PRAGMA foreign_keys = OFF');
  await knex.raw('DROP INDEX IF EXISTS event_day_statuses_event_id_day_unique');
  if (await knex.schema.hasTable('event_day_statuses_nullable_tmp')) {
    await knex.schema.dropTable('event_day_statuses_nullable_tmp');
  }
  await knex.schema.renameTable('event_day_statuses', 'event_day_statuses_nullable_tmp');
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
    FROM event_day_statuses_nullable_tmp
  `);
  await knex.schema.dropTable('event_day_statuses_nullable_tmp');
  await knex.raw('PRAGMA foreign_keys = ON');
};
