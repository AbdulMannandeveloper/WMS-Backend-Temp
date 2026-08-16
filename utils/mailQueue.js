'use strict';

/**
 * Lightweight in-process mail queue so HTTP handlers return without waiting
 * on SMTP. Retries failed deliveries with exponential backoff.
 *
 * For multi-instance deployments the worker runs per process; that is fine
 * for transactional mail. Swap for a Redis/Bull queue later if needed.
 */

const { sendMail } = require('./mailer');

const MAX_ATTEMPTS = Number(process.env.MAIL_QUEUE_MAX_ATTEMPTS || 3);
const BASE_DELAY_MS = Number(process.env.MAIL_QUEUE_BASE_DELAY_MS || 1000);

/** @type {Array<{ payload: object, attempts: number }>} */
const queue = [];
let draining = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const processQueue = async () => {
  if (draining) return;
  draining = true;

  while (queue.length > 0) {
    const job = queue.shift();
    try {
      const ok = await sendMail(job.payload);
      if (!ok) throw new Error('sendMail returned false');
    } catch (err) {
      job.attempts += 1;
      if (job.attempts < MAX_ATTEMPTS) {
        const wait = BASE_DELAY_MS * 2 ** (job.attempts - 1);
        console.error(
          `[MailQueue] Attempt ${job.attempts} failed for <${job.payload.to}>: ${err.message}. Retrying in ${wait}ms`,
        );
        await delay(wait);
        queue.push(job);
      } else {
        console.error(
          `[MailQueue] Dropping email to <${job.payload.to}> after ${MAX_ATTEMPTS} attempts: ${err.message}`,
        );
      }
    }
  }

  draining = false;
};

/**
 * Enqueue an email and return immediately. Delivery happens asynchronously.
 */
const enqueueMail = (payload) => {
  queue.push({ payload, attempts: 0 });
  setImmediate(() => {
    processQueue().catch((err) => {
      console.error('[MailQueue] Unexpected drain error:', err.message);
      draining = false;
    });
  });
  return true;
};

const getQueueDepth = () => queue.length;

module.exports = {
  enqueueMail,
  getQueueDepth,
};
