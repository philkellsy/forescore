'use strict';

const { layout, ctaButton, divider } = require('../layout');

/**
 * Welcome email for players who already have a ForeScore account.
 *
 * @param {object} data
 * @param {string} data.firstName
 * @param {string} data.tourLabel      — e.g. "Legends 2026"
 * @param {string} data.tenantName     — e.g. "Bonville International"
 * @param {string} data.inviterName    — display name of the admin who enrolled them
 * @param {string} data.tenantUrl      — tenant home URL (already signed in)
 */
function buildContent({ firstName, tourLabel, tenantName, inviterName, tenantUrl }) {
  const subject = `You've been added to ${tourLabel}`;
  const preheader = `${inviterName} has added you to ${tourLabel}. Your scorecard, itinerary and leaderboards are waiting.`;

  const body = `
    <h2 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#215463;">
      You're on the list, ${firstName}!
    </h2>

    <p style="margin:0 0 20px;">
      <strong>${inviterName}</strong> has added you to <strong>${tourLabel}</strong> with <strong>${tenantName}</strong>.
    </p>

    <p style="margin:0 0 20px;color:#4a5568;">
      Sign in to ForeScore to see your scorecard, tee times, itinerary and the leaderboard as the tour unfolds.
    </p>

    <div style="margin:16px 0 28px;text-align:center;">
      ${ctaButton({ label: 'Open ForeScore', url: tenantUrl })}
    </div>

    ${divider()}

    <p style="margin:0;font-size:13px;color:#4a5568;">
      If you haven't already, install ForeScore on your home screen for the best experience —
      tap <strong>Share → Add to Home Screen</strong> (iPhone) or <strong>Menu → Add to Home Screen</strong> (Android).
    </p>
  `;

  const text = [
    `You're on the list, ${firstName}!`,
    '',
    `${inviterName} has added you to ${tourLabel} with ${tenantName}.`,
    '',
    'Sign in to ForeScore to see your scorecard, tee times, itinerary and the leaderboard:',
    tenantUrl,
    '',
    'Install tip: tap Share → Add to Home Screen (iPhone) or Menu → Add to Home Screen (Android).',
  ].join('\n');

  const html = layout({ preheader, body });

  return { subject, html, text };
}

module.exports = { buildContent };
