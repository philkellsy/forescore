'use strict';

const { brevoApiKey, brevoSenderEmail, brevoSenderName, isProd, baseUrl } = require('../../config/env');
const welcomeNew      = require('./templates/welcome-new');
const welcomeExisting = require('./templates/welcome-existing');

// ── Transport ─────────────────────────────────────────────────────────────────

async function send(to, subject, html, text) {
  if (!brevoApiKey || !brevoSenderEmail) {
    console.log(`[email] dev-log to=${to} subject="${subject}"`);
    return { delivered: false, provider: 'log' };
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': brevoApiKey },
    body: JSON.stringify({
      sender: { name: brevoSenderName, email: 'welcome@forescore.me' },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`brevo_send_failed:${response.status}:${body.slice(0, 300)}`);
  }

  if (!isProd) {
    console.log(`[email] brevo_sent to=${to.slice(0, 3)}*** subject="${subject}"`);
  }

  return { delivered: true, provider: 'brevo' };
}

// ── Welcome email ─────────────────────────────────────────────────────────────

/**
 * Send a welcome email when a player is enrolled in a tour.
 *
 * @param {object} opts
 * @param {string}  opts.email        — recipient email
 * @param {string}  opts.firstName    — recipient first name
 * @param {string}  opts.tourLabel    — tour name, e.g. "Legends 2026"
 * @param {string}  opts.tenantName   — tenant display name
 * @param {string}  opts.tenantSlug   — tenant URL slug
 * @param {string}  opts.inviterName  — display name of the enrolling admin
 * @param {boolean} opts.isNewUser    — true = first-time ForeScore user
 */
async function sendWelcomeEmail({ email, firstName, tourLabel, tenantName, tenantSlug, inviterName, isNewUser }) {
  const base   = String(baseUrl || '').replace(/\/+$/, '');
  const loginUrl  = `${base}/${tenantSlug}/auth/login`;
  const tenantUrl = `${base}/${tenantSlug}/`;

  const { subject, html, text } = isNewUser
    ? welcomeNew.buildContent({ firstName, tourLabel, tenantName, inviterName, loginUrl })
    : welcomeExisting.buildContent({ firstName, tourLabel, tenantName, inviterName, tenantUrl });

  return send(email, subject, html, text);
}

module.exports = { send, sendWelcomeEmail };
