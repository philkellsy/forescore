'use strict';

const crypto = require('crypto');
const {
  LOGIN_CODE_EXPIRY_MINUTES,
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_RESEND_SECONDS
} = require('../../config/constants');

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateCode() {
  const max = 10 ** LOGIN_CODE_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(LOGIN_CODE_LENGTH, '0');
}

function buildExpiresAt() {
  const expiry = new Date();
  expiry.setMinutes(expiry.getMinutes() + LOGIN_CODE_EXPIRY_MINUTES);
  return expiry;
}

function parseDateMs(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeMobile(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeLookup(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.includes('@') ? normalizeEmail(trimmed) : normalizeMobile(trimmed);
}

function looksLikeEmail(value) {
  return String(value || '').includes('@');
}

function sanitizeCode(value) {
  return String(value || '').replace(/\D/g, '').slice(0, LOGIN_CODE_LENGTH);
}

async function findUserByLookup(db, rawLookup) {
  const normalized = normalizeLookup(rawLookup);
  if (!normalized) return null;

  if (looksLikeEmail(rawLookup)) {
    return db('users').whereRaw('lower(email) = ?', [normalized]).first();
  }

  return db('users').where({ phone_number: normalized }).first();
}

async function getResendRemainingSeconds(db, userId) {
  const lastCode = await db('login_codes')
    .where({ user_id: userId })
    .orderBy('created_at', 'desc')
    .first();

  if (!lastCode) return 0;

  const createdAtMs = parseDateMs(lastCode.created_at);
  if (!createdAtMs) return 0;

  const elapsedSeconds = Math.floor((Date.now() - createdAtMs) / 1000);
  return Math.max(0, LOGIN_CODE_RESEND_SECONDS - elapsedSeconds);
}

async function createLoginCode(db, userId, ip, userAgent) {
  const code = generateCode();
  const codeHash = hashCode(code);
  const expiresAt = buildExpiresAt();

  await db('login_codes').insert({
    user_id: userId,
    code_hash: codeHash,
    expires_at: expiresAt,
    ip: ip || null,
    user_agent: userAgent || null
  });

  return { code, expiresAt };
}

async function consumeLoginCode(db, userId, rawCode) {
  const code = sanitizeCode(rawCode);
  if (code.length !== LOGIN_CODE_LENGTH) return null;

  const codeHash = hashCode(code);
  const row = await db('login_codes')
    .where({ user_id: userId, code_hash: codeHash })
    .orderBy('id', 'desc')
    .first();

  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  await db('login_codes').where({ id: row.id }).update({ used_at: db.fn.now() });
  return row;
}

module.exports = {
  LOGIN_CODE_RESEND_SECONDS,
  normalizeMobile,
  normalizeLookup,
  sanitizeCode,
  findUserByLookup,
  getResendRemainingSeconds,
  createLoginCode,
  consumeLoginCode
};
