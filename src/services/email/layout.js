'use strict';

const { baseUrl } = require('../../config/env');

const BRAND_NAVY  = '#215463';
const BRAND_GREEN = '#8AD84A';
const BRAND_BG    = '#eef0ed';

function logoUrl() {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/img/icons/icon-192.png`;
}

/**
 * Renders a full HTML email document.
 *
 * @param {object} opts
 * @param {string} opts.preheader   — Preview text (hidden, appears in inbox)
 * @param {string} opts.body        — Inner HTML for the white content area
 * @param {string} [opts.footerNote] — Extra sentence in the footer
 */
function layout({ preheader, body, footerNote }) {
  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}&#8203;&#847; &#847; &#847; &#847; &#847; &#847;</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta name="x-apple-disable-message-reformatting"/>
  <!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
  <title>ForeScore</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND_BG};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  ${preheaderHtml}
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:${BRAND_BG};">
    <tr>
      <td style="padding:32px 12px;">

        <!-- Outer container -->
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center"
          style="max-width:600px;width:100%;margin:0 auto;background-color:#ffffff;border-radius:12px;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background-color:${BRAND_NAVY};padding:20px 28px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding-right:10px;vertical-align:middle;">
                    <img src="${logoUrl()}" alt="" width="36" height="36"
                      style="display:block;width:36px;height:36px;border-radius:6px;"/>
                  </td>
                  <td style="vertical-align:middle;">
                    <span style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;letter-spacing:0.3px;">
                      <span style="color:${BRAND_GREEN}">Fore</span><span style="color:#ffffff">Score</span>
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2d3748;">
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f7f8f7;padding:20px 28px;border-top:1px solid #e2e8e2;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#8a9a8a;text-align:center;">
                ForeScore &mdash; Golf Tour Management
                ${footerNote ? `<br/>${footerNote}` : ''}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

/**
 * Renders a CTA button compatible with all major email clients (Outlook VML trick).
 */
function ctaButton({ label, url }) {
  return `
    <!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
      href="${url}" style="height:48px;v-text-anchor:middle;width:220px;" arcsize="17%"
      stroke="f" fillcolor="${BRAND_GREEN}">
      <w:anchorlock/>
      <center style="color:#1a3d1a;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;">${label}</center>
    </v:roundrect>
    <![endif]-->
    <!--[if !mso]><!-->
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
      <tr>
        <td style="background-color:${BRAND_GREEN};border-radius:8px;text-align:center;">
          <a href="${url}"
            style="display:inline-block;padding:14px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#1a3d1a;text-decoration:none;border-radius:8px;">
            ${label}
          </a>
        </td>
      </tr>
    </table>
    <!--<![endif]-->`.trim();
}

/**
 * Renders a horizontal rule divider.
 */
function divider() {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0;">
    <tr><td style="border-top:1px solid #e2e8e2;"></td></tr>
  </table>`;
}

module.exports = { layout, ctaButton, divider };
