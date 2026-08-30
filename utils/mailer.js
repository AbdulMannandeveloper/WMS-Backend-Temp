const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || 'no-reply@propackersuk.local';

// "smtp" -> deliver via SMTP. Anything else -> mock (no email sent).
const MAIL_TRANSPORT = String(process.env.MAIL_TRANSPORT || '').toLowerCase();
// Only print the (sensitive) email body in mock mode when explicitly opted in.
const MAIL_DEBUG = String(process.env.MAIL_DEBUG || '').toLowerCase() === 'true';

let transporter;

/** Exported so the IPv4 default can be asserted without opening a socket. */
const buildTransportOptions = () => ({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  // 4 or 6 only. Number('nonsense') is NaN, and an unset family is exactly the
  // condition this exists to prevent — so a typo falls back to IPv4 rather than
  // quietly restoring the bug.
  family: process.env.SMTP_IP_FAMILY === '6' ? 6 : 4,
});

const getTransporter = () => {
  if (!transporter) {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      throw new Error('SMTP configuration is missing. Set SMTP_HOST, SMTP_USER, and SMTP_PASS.');
    }

    transporter = nodemailer.createTransport(buildTransportOptions());
  }

  return transporter;
};

const sendMail = async ({ to, subject, html, text }) => {
  try {
    if (MAIL_TRANSPORT === 'smtp') {
      const tx = getTransporter();
      await tx.sendMail({ from: MAIL_FROM, to, subject, text, html });
      return true;
    }

    // Mock mode: never log OTP codes / setup links unless MAIL_DEBUG is enabled.
    if (MAIL_DEBUG) {
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
  } catch (error) {
    console.error('[Mailer] Failed to send email:', error.message);
    return false;
  }
};

module.exports = {
  sendMail,
  buildTransportOptions,
};
