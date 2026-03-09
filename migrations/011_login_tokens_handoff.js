'use strict';

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('login_tokens');
  if (!hasTable) return;

  const hasHandoffId = await knex.schema.hasColumn('login_tokens', 'handoff_id');
  const hasHandoffCompletedAt = await knex.schema.hasColumn('login_tokens', 'handoff_completed_at');

  if (!hasHandoffId || !hasHandoffCompletedAt) {
    await knex.schema.alterTable('login_tokens', (table) => {
      if (!hasHandoffId) table.string('handoff_id');
      if (!hasHandoffCompletedAt) table.timestamp('handoff_completed_at');
    });
  }

  await knex.schema.raw(
    'CREATE INDEX IF NOT EXISTS idx_login_tokens_handoff_id ON login_tokens (handoff_id)'
  );
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('login_tokens');
  if (!hasTable) return;

  await knex.schema.raw('DROP INDEX IF EXISTS idx_login_tokens_handoff_id');

  const hasHandoffId = await knex.schema.hasColumn('login_tokens', 'handoff_id');
  const hasHandoffCompletedAt = await knex.schema.hasColumn('login_tokens', 'handoff_completed_at');

  if (hasHandoffId || hasHandoffCompletedAt) {
    await knex.schema.alterTable('login_tokens', (table) => {
      if (hasHandoffId) table.dropColumn('handoff_id');
      if (hasHandoffCompletedAt) table.dropColumn('handoff_completed_at');
    });
  }
};

