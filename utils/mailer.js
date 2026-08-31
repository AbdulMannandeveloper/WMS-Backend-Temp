'use strict';

/**
 * Outbound email, over one of three transports.
 *
 *   brevo  — HTTPS POST to Brevo's transactional API
 *   smtp   — a direct SMTP connection through nodemailer
 *   (else) — mock: nothing is sent
 *
 * Brevo exists because Render's free tier blocks outbound SMTP entirely (ports
 * 25, 465 and 587), so a direct connection cannot work there however correct the
 * credentials are. An HTTP API is an ordinary HTTPS request and is unaffected.
 *
 * Everything above this file calls sendMail() and knows nothing about which
 * transport is in use. The retry, backoff and dead-lettering in utils/mailQueue
 * sit on top and are unchanged.
 *
 * Configuration is read per call rather than at module load, so a test can vary
 * it without re-importing the module.
 */

const nodemailer = require('nodemailer');

const config = () => ({
  transport: String(process.env.MAIL_TRANSPORT || '').toLowerCase(),
  from: process.env.MAIL_FROM || 'no-reply@propackersuk.local',
  fromName: process.env.MAIL_FROM_NAME || 'ProPackers UK',
  debug: String(process.env.MAIL_DEBUG || '').toLowerCase() === 'true',
});

// ─── Brevo ────────────────────────────────────────────────────────────────────

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

/** How long to wait on the API before giving up and letting the queue retry. */
const BREVO_TIMEOUT_MS = Number(process.env.BREVO_TIMEOUT_MS || 15000);

/**
 * The request body Brevo expects.
 *
 * Exported so its shape can be asserted without making a network call — the
 * sender/to structure is nested and easy to get subtly wrong, and the failure
 * would be a 400 at runtime rather than anything visible in review.
 */
const buildBrevoPayload = ({ to, subject, html, text }) => {
  const { from, fromName } = config();

  const payload = {
    sender: { email: from, name: fromName },
    to: [{ email: to }],
    subject,
  };

  // Brevo rejects a message with neither. Both are sent when both exist, so a
  // client that cannot render HTML still gets something readable.
  if (html) payload.htmlContent = html;
  if (text) payload.textContent = text;

  return payload;
};

const sendViaBrevo = async ({ to, subject, html, text }) => {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not set.');
  }
  if (!html && !text) {
    throw new Error('An email needs an html or text body.');
  }

  const response = await fetch(BREVO_ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(buildBrevoPayload({ to, subject, html, text })),
    // Without this a hung connection blocks the mail queue indefinitely.
    signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
  });

  if (!response.ok) {
    // Brevo explains refusals in the body — an unverified sender, a bad key, a
    // quota. Surfacing that is the difference between a five-second fix and an
    // afternoon. The key itself never appears here.
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.message || body?.code || JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(
      `Brevo refused the message (HTTP ${response.status}): ${detail || 'no detail given'}`,
    );
  }

  return true;
};

// ─── SMTP ─────────────────────────────────────────────────────────────────────

let transporter;

/** Exported so the IPv4 default can be asserted without opening a socket. */
const buildTransportOptions = () => ({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  // 4 or 6 only. Number('nonsense') is NaN, and an unset family is exactly the
  // condition this exists to prevent — so a typo falls back to IPv4 rather than
  // quietly restoring the bug. smtp.gmail.com is dual-stack and a host with no
  // IPv6 route fails with ENETUNREACH before reaching the server.
  family: process.env.SMTP_IP_FAMILY === '6' ? 6 : 4,
});

const getTransporter = () => {
  if (!transporter) {
    const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      throw new Error('SMTP configuration is missing. Set SMTP_HOST, SMTP_USER, and SMTP_PASS.');
    }
    transporter = nodemailer.createTransport(buildTransportOptions());
  }

  return transporter;
};

const sendViaSmtp = async ({ to, subject, html, text }) => {
  const { from } = config();
  await getTransporter().sendMail({ from, to, subject, text, html });
  return true;
};

// ─── Mock ─────────────────────────────────────────────────────────────────────

const sendViaMock = ({ to, subject, html, text }) => {
  const { debug } = config();

  // Never print OTP codes or setup links unless explicitly asked: they are
  // credentials, and logs are read by more people than inboxes are.
  if (debug) {
    console.log('\n=================== MOCK EMAIL (MAIL_DEBUG) ===================');
    console.log(`To:      ${to}`);
    console.log(`Subject: ${subject}`);
    console.log('--------------------------------------------------------------');
    if (text) console.log(text);
    else if (html) console.log(html);
    console.log('==============================================================\n');
  } else {
    console.log(`[Mailer] (mock) email queued to <${to}> — subject: "${subject}"`);
  }

  return true;
};

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * @returns {Promise<boolean>} whether it was accepted. False makes the queue
 *   retry, then dead-letter — it never silently drops the message.
 */
const sendMail = async ({ to, subject, html, text }) => {
  const { transport } = config();

  try {
    if (transport === 'brevo') return await sendViaBrevo({ to, subject, html, text });
    if (transport === 'smtp') return await sendViaSmtp({ to, subject, html, text });
    return sendViaMock({ to, subject, html, text });
  } catch (error) {
    console.error(`[Mailer] Failed to send email via ${transport || 'mock'}:`, error.message);
    return false;
  }
};

/**
 * Says at boot what will happen to email, because the default is to send
 * nothing.
 *
 * An unset MAIL_TRANSPORT means mock mode: every invitation and OTP is logged
 * and discarded, no error is raised, and the user is told to check an inbox
 * nothing will arrive in. That is a reasonable default for development and a
 * silent failure in production, so it is worth one loud line either way.
 */
const describeMailTransport = () => {
  const { transport, from } = config();

  if (transport === 'brevo') {
    return process.env.BREVO_API_KEY
      ? `[Mailer] Sending via Brevo as <${from}>`
      : '[Mailer] WARNING: MAIL_TRANSPORT=brevo but BREVO_API_KEY is not set — every email will fail';
  }

  if (transport === 'smtp') {
    return `[Mailer] Sending via SMTP (${process.env.SMTP_HOST}) as <${from}>`;
  }

  const warning =
    '[Mailer] WARNING: MAIL_TRANSPORT is not set — running in mock mode, NO EMAIL WILL BE SENT';
  return process.env.NODE_ENV === 'production'
    ? `${warning}. This is almost certainly wrong in production.`
    : warning;
};

module.exports = {
  sendMail,
  buildTransportOptions,
  buildBrevoPayload,
  describeMailTransport,
  BREVO_ENDPOINT,
};
