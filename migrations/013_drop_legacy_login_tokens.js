'use strict';

exports.up = async function up(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_login_tokens_claim_nonce');
  await knex.raw('DROP INDEX IF EXISTS idx_login_tokens_handoff_id');
  await knex.schema.dropTableIfExists('login_tokens');
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('login_tokens');
  if (hasTable) return;

  await knex.schema.createTable('login_tokens', (table) => {
    table.increments('id').primary();
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('token_hash').notNullable().unique();
    table.timestamp('expires_at').notNullable();
    table.timestamp('used_at');
    table.string('ip');
    table.string('user_agent');
    table.string('claim_nonce');
    table.string('handoff_id');
    table.timestamp('handoff_completed_at');
    table.timestamps(true, true);
  });

  await knex.raw('CREATE INDEX IF NOT EXISTS idx_login_tokens_claim_nonce ON login_tokens (claim_nonce)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_login_tokens_handoff_id ON login_tokens (handoff_id)');
};

