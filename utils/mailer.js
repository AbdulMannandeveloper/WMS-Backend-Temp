const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || 'no-reply@propackersuk.local';

let transporter;

const getTransporter = () => {
  if (!transporter) {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      throw new Error('SMTP configuration is missing. Set SMTP_HOST, SMTP_USER, and SMTP_PASS.');
    }

    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });
  }

  return transporter;
};

const sendMail = async ({ to, subject, html, text }) => {
  try {
    const tx = getTransporter();

    await tx.sendMail({
      from: MAIL_FROM,
      to,
      subject,
      text,
      html,
    });

    return true;
  } catch (error) {
    console.error('[Mailer] Failed to send email:', error.message);
    return false;
  }
};

module.exports = {
  sendMail,
};
