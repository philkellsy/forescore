'use strict';

exports.up = async function (knex) {
  await knex.schema.createTable('session_logs', (t) => {
    t.increments('id').primary();
    t.integer('user_id').references('id').inTable('users').onDelete('SET NULL').nullable();
    t.integer('tenant_id').references('id').inTable('tenants').onDelete('SET NULL').nullable();
    t.string('event', 50).notNullable();
    t.string('ip_address', 45).nullable();
    t.text('user_agent').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw('CREATE INDEX idx_session_logs_user_id   ON session_logs(user_id)');
  await knex.schema.raw('CREATE INDEX idx_session_logs_tenant_id ON session_logs(tenant_id)');
  await knex.schema.raw('CREATE INDEX idx_session_logs_created_at ON session_logs(created_at DESC)');
};

exports.down = async function (knex) {
  await knex.schema.dropTable('session_logs');
};
