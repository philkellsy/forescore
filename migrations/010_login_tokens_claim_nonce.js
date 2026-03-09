'use strict';

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('login_tokens');
  if (!hasTable) return;

  const hasClaimNonce = await knex.schema.hasColumn('login_tokens', 'claim_nonce');
  if (!hasClaimNonce) {
    await knex.schema.alterTable('login_tokens', (table) => {
      table.string('claim_nonce');
    });
  }

  await knex.schema.raw(
    'CREATE INDEX IF NOT EXISTS idx_login_tokens_claim_nonce ON login_tokens (claim_nonce)'
  );
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('login_tokens');
  if (!hasTable) return;

  await knex.schema.raw('DROP INDEX IF EXISTS idx_login_tokens_claim_nonce');

  const hasClaimNonce = await knex.schema.hasColumn('login_tokens', 'claim_nonce');
  if (hasClaimNonce) {
    await knex.schema.alterTable('login_tokens', (table) => {
      table.dropColumn('claim_nonce');
    });
  }
};

