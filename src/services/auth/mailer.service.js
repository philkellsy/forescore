'use strict';

const {
  brevoApiKey,
  brevoSenderEmail,
  brevoSenderName,
  isProd
} = require('../../config/env');

function buildMagicLinkContent(link) {
  const subject = 'Your Legends Magic Link';
  const htmlContent = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#1f2937;">
      <h2 style="margin:0 0 12px;color:#0e5135;">Legends Sign-In</h2>
      <p style="margin:0 0 12px;">Use the secure magic link below to sign in:</p>
      <p style="margin:0 0 16px;">
        <a href="${link}" style="display:inline-block;background:#0e5135;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px;font-weight:600;">
          Sign in to Legends
        </a>
      </p>
      <p style="margin:0 0 8px;">If the button doesn't work, copy and paste this URL:</p>
      <p style="margin:0 0 12px;word-break:break-all;"><a href="${link}">${link}</a></p>
      <p style="margin:0;color:#6b7280;font-size:13px;">
        This link expires shortly and can only be used once. If you did not request this, you can ignore this email.
      </p>
    </div>
  `.trim();
  const textContent = [
    'Legends Sign-In',
    '',
    'Use this secure magic link to sign in:',
    link,
    '',
    'This link expires shortly and can only be used once.',
    'If you did not request this, you can ignore this email.'
  ].join('\n');
  return { subject, htmlContent, textContent };
}

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

async function sendMagicLink(email, link) {
  const { subject, htmlContent, textContent } = buildMagicLinkContent(link);

  if (!brevoApiKey || !brevoSenderEmail) {
    // Local/dev fallback while provider credentials are not configured.
    console.log(`[magic-link] ${email} -> ${link}`);
    return { delivered: false, provider: 'log' };
  }

  await sendWithBrevo(email, subject, htmlContent, textContent);
  if (!isProd) {
    console.log(`[magic-link] brevo_sent -> ${maskEmail(email)}`);
  }
  return { delivered: true, provider: 'brevo' };
}

module.exports = { sendMagicLink };
