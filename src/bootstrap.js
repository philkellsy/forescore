'use strict';

async function runMigrations(db) {
  await db.migrate.latest();
}

async function seedDefaults(db) {
  const email = 'phil@kellsy.com';

  let user = await db('users').where({ email }).first();
  if (!user) {
    [user] = await db('users')
      .insert({
        first_name: 'Phil',
        last_name: 'Kells',
        email,
        phone_number: '0404878210',
        email_verified_at: db.fn.now(),
        is_super_admin: true,
        gender: 'male',
      })
      .returning('*');
  } else if (!user.is_super_admin) {
    await db('users').where({ id: user.id }).update({ is_super_admin: true });
  }

  // Seed initial tenant — exists so admins have somewhere to log in while setting up
  let tenant = await db('tenants').where({ slug: 'init' }).first();
  if (!tenant) {
    [tenant] = await db('tenants')
      .insert({
        name: 'ForeScore',
        slug: 'init',
        plan: 'pro',
        subscription_status: 'active',
        settings: JSON.stringify({}),
      })
      .returning('*');
  }

  const membership = await db('tenant_memberships')
    .where({ tenant_id: tenant.id, user_id: user.id })
    .first();
  if (!membership) {
    await db('tenant_memberships').insert({
      tenant_id: tenant.id,
      user_id: user.id,
      role: 'owner',
    });
  }
}

async function bootstrap(db) {
  if (process.env.NODE_ENV !== 'production') {
    await runMigrations(db);
  }
  await seedDefaults(db);
}

module.exports = { bootstrap };
