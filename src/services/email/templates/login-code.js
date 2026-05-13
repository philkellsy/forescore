'use strict';

const { layout, divider } = require('../layout');

/**
 * One-time sign-in code email.
 *
 * @param {object} data
 * @param {string} data.code              — 6-digit OTP
 * @param {number} data.expiryMinutes     — e.g. 15
 */
function buildContent({ code, expiryMinutes }) {
  const subject = 'Your ForeScore Sign-In Code';
  const preheader = `Your sign-in code is ${code}. It expires in ${expiryMinutes} minutes.`;

  const body = `
    <h2 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#215463;">
      Sign in to ForeScore
    </h2>

    <p style="margin:0 0 20px;">
      Use this one-time code to sign in to your account:
    </p>

    <div style="text-align:center;margin:0 0 24px;">
      <div style="display:inline-block;padding:16px 28px;border:2px solid #215463;border-radius:10px;
                  background:#f4f7f4;font-size:34px;font-weight:700;letter-spacing:10px;
                  color:#215463;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
        ${code}
      </div>
    </div>

    <p style="margin:0 0 8px;color:#4a5568;text-align:center;">
      This code expires in <strong>${expiryMinutes} minutes</strong> and can only be used once.
    </p>

    ${divider()}

    <p style="margin:0;font-size:13px;color:#8a9a8a;text-align:center;">
      If you did not request this code, you can safely ignore this email.
    </p>
  `;

  const text = [
    'Sign in to ForeScore',
    '',
    'Your one-time sign-in code:',
    '',
    `  ${code}`,
    '',
    `This code expires in ${expiryMinutes} minutes and can only be used once.`,
    '',
    'If you did not request this code, you can safely ignore this email.',
  ].join('\n');

  const html = layout({ preheader, body });

  return { subject, html, text };
}

module.exports = { buildContent };
