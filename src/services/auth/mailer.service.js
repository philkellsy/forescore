'use strict';

async function sendMagicLink(email, link) {
  // Development-friendly mailer: logs the link for local use.
  console.log(`[magic-link] ${email} -> ${link}`);
}

module.exports = { sendMagicLink };
