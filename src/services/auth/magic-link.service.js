'use strict';

const crypto = require('crypto');
const { MAGIC_LINK_EXPIRY_MINUTES } = require('../../config/constants');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function buildExpiresAt() {
  const expiry = new Date();
  expiry.setMinutes(expiry.getMinutes() + MAGIC_LINK_EXPIRY_MINUTES);
  return expiry;
}

async function createLoginToken(db, userId, ip, userAgent) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = buildExpiresAt();

  await db('login_tokens').insert({
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
    ip: ip || null,
    user_agent: userAgent || null
  });

  return { token, expiresAt };
}

async function consumeLoginToken(db, rawToken) {
  const tokenHash = hashToken(rawToken);
  const row = await db('login_tokens').where({ token_hash: tokenHash }).first();

  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  await db('login_tokens').where({ id: row.id }).update({ used_at: db.fn.now() });
  return row;
}

module.exports = {
  createLoginToken,
  consumeLoginToken
};
