'use strict';

exports.up = async function up(knex) {
  await knex.schema.alterTable('courses', (table) => {
    table.integer('api_course_id').nullable();
    table.string('api_tee_key').nullable(); // "<gender>:<tee_name>"
    table.unique(['api_course_id', 'api_tee_key'], { indexName: 'courses_api_unique' });
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('courses', (table) => {
    table.dropUnique(['api_course_id', 'api_tee_key'], 'courses_api_unique');
    table.dropColumn('api_tee_key');
    table.dropColumn('api_course_id');
  });
};
