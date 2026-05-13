'use strict';

const { layout, ctaButton, divider } = require('../layout');

/**
 * Welcome email for players who are new to ForeScore (no prior account).
 *
 * @param {object} data
 * @param {string} data.firstName
 * @param {string} data.tourLabel      — e.g. "Legends 2026"
 * @param {string} data.tenantName     — e.g. "Bonville International"
 * @param {string} data.inviterName    — display name of the admin who enrolled them
 * @param {string} data.loginUrl       — tenant login URL
 */
function buildContent({ firstName, tourLabel, tenantName, inviterName, loginUrl }) {
  const subject = `Welcome to ForeScore — you've been added to ${tourLabel}`;
  const preheader = `${inviterName} has added you to ${tourLabel}. Sign in to see your scorecard, itinerary and more.`;

  const body = `
    <h2 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#215463;">
      Welcome to ForeScore, ${firstName}!
    </h2>

    <p style="margin:0 0 12px;">
      <strong>${inviterName}</strong> has added you to <strong>${tourLabel}</strong> with <strong>${tenantName}</strong>.
    </p>

    <p style="margin:0 0 20px;color:#4a5568;">
      ForeScore is a mobile-first golf tour app designed to take your Golf tour with your mates to the next level. During the tour you'll be able to:
    </p>

    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 24px;">
      <tr>
        <td style="padding:8px 0;vertical-align:top;width:28px;font-size:18px;">📅</td>
        <td style="padding:8px 0;vertical-align:top;font-size:15px;color:#2d3748;">View the full tour itinerary — tee times, playing partners, meals, accommodation, activities, transportation and more.</td>
      </tr>
      <tr>
        <td style="padding:8px 0;vertical-align:top;width:28px;font-size:18px;">⛳</td>
        <td style="padding:8px 0;vertical-align:top;font-size:15px;color:#2d3748;">Enter your scores hole-by-hole from your phone — even offline. No more scorecards, no more paperwork.</td>
      </tr>
      <tr>
        <td style="padding:8px 0;vertical-align:top;width:28px;font-size:18px;">🏆</td>
        <td style="padding:8px 0;vertical-align:top;font-size:15px;color:#2d3748;">Follow the leaderboard and all results each day. See tour style scorecards for every player, every round.</td>
      </tr>
      <tr>
        <td style="padding:8px 0;vertical-align:top;width:28px;font-size:18px;">🥇</td>
        <td style="padding:8px 0;vertical-align:top;font-size:15px;color:#2d3748;">FourScore tracks scores, skins, NTP's, Long Drives, Prizes and more.</td>
      </tr>
    </table>

    <p style="margin:0 0 8px;font-weight:700;color:#215463;">Sign in with your email address to get started:</p>

    <div style="margin:16px 0 24px;text-align:center;">
      ${ctaButton({ label: 'Sign in to ForeScore', url: loginUrl })}
    </div>

    ${divider()}

    <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#215463;">
      📱 Install ForeScore on your phone
    </p>
    <p style="margin:0;font-size:13px;color:#4a5568;">
      After signing in, tap <strong>Share → Add to Home Screen</strong> (iPhone) or
      <strong>Menu → Add to Home Screen</strong> (Android) for the best experience.
      The app works offline so you can score even without reception.
    </p>
  `;

  const text = [
    `Welcome to ForeScore, ${firstName}!`,
    '',
    `${inviterName} has added you to ${tourLabel} with ${tenantName}.`,
    '',
    'ForeScore is a mobile-first golf tour app where you can:',
    '  - Enter your scores hole-by-hole from your phone',
    '  - Follow the leaderboard in real time',
    '  - View the full tour itinerary',
    '',
    'Sign in with your email address to get started:',
    loginUrl,
    '',
    'Install ForeScore on your phone:',
    'iPhone: Sign in → Share → Add to Home Screen',
    'Android: Sign in → Menu → Add to Home Screen',
    '',
    'The app works offline so you can score even without reception.',
  ].join('\n');

  const html = layout({ preheader, body });

  return { subject, html, text };
}

module.exports = { buildContent };
