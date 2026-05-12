'use strict';

function normalizeMobile(value) {
  return String(value || '').replace(/\D/g, '');
}

exports.up = async function up(knex) {
  const hasUsers = await knex.schema.hasTable('users');
  if (hasUsers) {
    const rows = await knex('users').select('id', 'phone_number').whereNotNull('phone_number');
    const seen = new Map();

    for (const row of rows) {
      const normalized = normalizeMobile(row.phone_number);
      if (!normalized) {
        await knex('users')
          .where({ id: row.id })
          .update({ phone_number: null, updated_at: knex.fn.now() });
        continue;
      }
      const existingUserId = seen.get(normalized);
      if (existingUserId) {
        await knex('users')
          .where({ id: row.id })
          .update({ phone_number: null, updated_at: knex.fn.now() });
        continue;
      }
      seen.set(normalized, row.id);
      if (normalized !== String(row.phone_number || '')) {
        await knex('users')
          .where({ id: row.id })
          .update({ phone_number: normalized, updated_at: knex.fn.now() });
      }
    }

    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_users_phone_number_unique
      ON users (phone_number)
      WHERE phone_number IS NOT NULL AND trim(phone_number) <> ''
    `);
  }

  const hasLoginCodes = await knex.schema.hasTable('login_codes');
  if (!hasLoginCodes) {
    await knex.schema.createTable('login_codes', (table) => {
      table.increments('id').primary();
      table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.string('code_hash').notNullable();
      table.timestamp('expires_at').notNullable();
      table.timestamp('used_at');
      table.string('ip');
      table.string('user_agent');
      table.timestamps(true, true);
    });
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_login_codes_user_created
    ON login_codes (user_id, created_at DESC)
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_login_codes_user_created');
  await knex.schema.dropTableIfExists('login_codes');
  await knex.raw('DROP INDEX IF EXISTS ux_users_phone_number_unique');
};
