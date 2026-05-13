'use strict';

const {
  brevoApiKey,
  brevoSenderEmail,
  brevoSenderName,
  isProd,
} = require('../../config/env');
const { LOGIN_CODE_EXPIRY_MINUTES } = require('../../config/constants');
const { buildContent: buildLoginCodeContent } = require('../email/templates/login-code');
const { buildContent: buildEmailChangeContent } = require('../email/templates/email-change');

function maskEmail(email) {
  const value = String(email || '').trim();
  const [localPart, domain = ''] = value.split('@');
  if (!localPart) return value;
  const visible = localPart.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(0, localPart.length - 2))}@${domain}`;
}

async function sendWithBrevo(email, subject, htmlContent, textContent) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'api-key': brevoApiKey
    },
    body: JSON.stringify({
      sender: {
        name: brevoSenderName,
        email: brevoSenderEmail
      },
      to: [{ email }],
      subject,
      htmlContent,
      textContent
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`brevo_send_failed:${response.status}:${body.slice(0, 300)}`);
  }
}

async function sendLoginCode(email, code) {
  const { subject, html, text } = buildLoginCodeContent({ code, expiryMinutes: LOGIN_CODE_EXPIRY_MINUTES });

  if (!brevoApiKey || !brevoSenderEmail) {
    console.log(`[login-code] ${email} -> ${code}`);
    return { delivered: false, provider: 'log' };
  }

  await sendWithBrevo(email, subject, html, text);
  if (!isProd) {
    console.log(`[login-code] brevo_sent -> ${maskEmail(email)}`);
  }
  return { delivered: true, provider: 'brevo' };
}

async function sendEmailChangeCode(email, code) {
  const { subject, html, text } = buildEmailChangeContent({ code, expiryMinutes: LOGIN_CODE_EXPIRY_MINUTES });

  if (!brevoApiKey || !brevoSenderEmail) {
    console.log(`[email-change] ${email} -> ${code}`);
    return { delivered: false, provider: 'log' };
  }

  await sendWithBrevo(email, subject, html, text);
  if (!isProd) {
    console.log(`[email-change] brevo_sent -> ${maskEmail(email)}`);
  }
  return { delivered: true, provider: 'brevo' };
}

module.exports = { sendLoginCode, sendEmailChangeCode };

