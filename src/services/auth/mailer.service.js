'use strict';

const {
  brevoApiKey,
  brevoSenderEmail,
  brevoSenderName,
  isProd,
  baseUrl
} = require('../../config/env');
const { LOGIN_CODE_EXPIRY_MINUTES } = require('../../config/constants');

function buildLoginCodeContent(code) {
  const logoUrl = `${String(baseUrl || '').replace(/\/+$/, '')}/img/legends2.png`;
  const subject = 'Your Legends Sign-In Code';
  const htmlContent = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#1f2937;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 12px;background:#0e5135;border-radius:8px;">
        <tr>
          <td style="padding:10px 12px;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="padding-right:10px;vertical-align:middle;">
                  <img src="${logoUrl}" alt="Legends" width="28" height="28" style="display:block;width:28px;height:28px;border-radius:4px;">
                </td>
                <td style="vertical-align:middle;color:#ffffff;font-size:16px;font-weight:700;letter-spacing:0.3px;">
                  Legends
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
      <h2 style="margin:0 0 12px;color:#0e5135;">Legends Sign-In</h2>
      <p style="margin:0 0 12px;">Use this one-time code to sign in:</p>
      <div style="display:inline-block;margin:0 0 14px;padding:10px 16px;border:1px solid #d1d5db;border-radius:8px;background:#f9fafb;font-size:28px;font-weight:700;letter-spacing:6px;color:#0e5135;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
        ${code}
      </div>
      <p style="margin:0 0 8px;">This code expires in ${LOGIN_CODE_EXPIRY_MINUTES} minutes and can only be used once.</p>
      <p style="margin:0;color:#6b7280;font-size:13px;">
        If you did not request this sign-in code, you can ignore this email.
      </p>
    </div>
  `.trim();
  const textContent = [
    'Legends Sign-In',
    '',
    'Use this one-time code to sign in:',
    String(code),
    '',
    `This code expires in ${LOGIN_CODE_EXPIRY_MINUTES} minutes and can only be used once.`,
    'If you did not request this code, you can ignore this email.'
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

async function sendLoginCode(email, code) {
  const { subject, htmlContent, textContent } = buildLoginCodeContent(code);

  if (!brevoApiKey || !brevoSenderEmail) {
    console.log(`[login-code] ${email} -> ${code}`);
    return { delivered: false, provider: 'log' };
  }

  await sendWithBrevo(email, subject, htmlContent, textContent);
  if (!isProd) {
    console.log(`[login-code] brevo_sent -> ${maskEmail(email)}`);
  }
  return { delivered: true, provider: 'brevo' };
}

module.exports = { sendLoginCode };

