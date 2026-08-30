'use strict';

/**
 * Outbound mail, queued so HTTP handlers return without waiting on SMTP.
 *
 * It used to be an in-process array. Anything queued when a worker restarted —
 * an invitation, a login OTP, an approved invoice — was simply gone, with the
 * user staring at a screen telling them to check their email.
 *
 * Backed by a Redis list when REDIS_URL is set, so the queue survives a restart
 * and any worker can drain it. The reliable-queue pattern is used deliberately:
 * a job is moved to a processing list while it is being sent and only removed on
 * success, so a worker dying mid-send leaves the job recoverable rather than
 * consumed. Without REDIS_URL it stays in memory, which is correct for a
 * single-process development run.
 */

const { sendMail } = require('./mailer');

const MAX_ATTEMPTS = Number(process.env.MAIL_QUEUE_MAX_ATTEMPTS || 3);
const BASE_DELAY_MS = Number(process.env.MAIL_QUEUE_BASE_DELAY_MS || 1000);

const QUEUE_KEY = 'mail:queue';
const PROCESSING_KEY = 'mail:processing';
const DEAD_KEY = 'mail:dead';

/** @type {Array<{ payload: object, attempts: number }>} */
const memoryQueue = [];
let draining = false;

let redis = null;
let redisChecked = false;

const getRedis = () => {
  if (redisChecked) return redis;
  redisChecked = true;

  if (!process.env.REDIS_URL) return null;
  try {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
    redis.on('error', (err) =>
      console.error('[MailQueue] Redis error, falling back to memory:', err.message),
    );
  } catch (err) {
    console.error('[MailQueue] Redis unavailable, using memory:', err.message);
    redis = null;
  }
  return redis;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends one job, returning whether it should be retried. */
const attemptSend = async (job) => {
  try {
    const ok = await sendMail(job.payload);
    if (!ok) throw new Error('sendMail returned false');
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
};

const drainMemory = async () => {
  if (draining) return;
  draining = true;

  while (memoryQueue.length > 0) {
    const job = memoryQueue.shift();
    const result = await attemptSend(job);
    if (result.sent) continue;

    job.attempts += 1;
    if (job.attempts < MAX_ATTEMPTS) {
      const wait = BASE_DELAY_MS * 2 ** (job.attempts - 1);
      console.error(
        `[MailQueue] Attempt ${job.attempts} failed for <${job.payload.to}>: ${result.error}. Retrying in ${wait}ms`,
      );
      await delay(wait);
      memoryQueue.push(job);
    } else {
      console.error(
        `[MailQueue] Dropping email to <${job.payload.to}> after ${MAX_ATTEMPTS} attempts: ${result.error}`,
      );
    }
  }

  draining = false;
};

const drainRedis = async (client) => {
  if (draining) return;
  draining = true;

  try {
    for (;;) {
      // Atomically claim a job: it leaves the queue and appears in processing,
      // so a crash here leaves it recoverable instead of lost.
      const raw = await client.rpoplpush(QUEUE_KEY, PROCESSING_KEY);
      if (!raw) break;

      let job;
      try {
        job = JSON.parse(raw);
      } catch {
        await client.lrem(PROCESSING_KEY, 1, raw);
        continue;
      }

      const result = await attemptSend(job);
      // Claimed and finished with, either way — what happens next is a fresh
      // enqueue, so the processing entry always goes.
      await client.lrem(PROCESSING_KEY, 1, raw);

      if (result.sent) continue;

      job.attempts = (job.attempts || 0) + 1;
      if (job.attempts < MAX_ATTEMPTS) {
        const wait = BASE_DELAY_MS * 2 ** (job.attempts - 1);
        console.error(
          `[MailQueue] Attempt ${job.attempts} failed for <${job.payload.to}>: ${result.error}. Retrying in ${wait}ms`,
        );
        await delay(wait);
        await client.lpush(QUEUE_KEY, JSON.stringify(job));
      } else {
        // Kept rather than discarded: an invitation nobody received is worth
        // being able to find afterwards.
        console.error(
          `[MailQueue] Dead-lettering email to <${job.payload.to}> after ${MAX_ATTEMPTS} attempts: ${result.error}`,
        );
        await client.lpush(DEAD_KEY, JSON.stringify({ ...job, failedAt: new Date().toISOString() }));
      }
    }
  } finally {
    draining = false;
  }
};

const processQueue = async () => {
  const client = getRedis();
  if (client) return drainRedis(client);
  return drainMemory();
};

/** Enqueues an email and returns immediately. Delivery happens asynchronously. */
const enqueueMail = (payload) => {
  const client = getRedis();
  const job = { payload, attempts: 0 };

  if (client) {
    client
      .lpush(QUEUE_KEY, JSON.stringify(job))
      .then(() => {
        setImmediate(() => {
          processQueue().catch((err) => {
            console.error('[MailQueue] Unexpected drain error:', err.message);
            draining = false;
          });
        });
      })
      .catch((err) => {
        // Redis refused it — better in memory than nowhere.
        console.error('[MailQueue] Falling back to memory for this job:', err.message);
        memoryQueue.push(job);
        setImmediate(() => drainMemory().catch(() => { draining = false; }));
      });
    return true;
  }

  memoryQueue.push(job);
  setImmediate(() => {
    drainMemory().catch((err) => {
      console.error('[MailQueue] Unexpected drain error:', err.message);
      draining = false;
    });
  });
  return true;
};

const getQueueDepth = async () => {
  const client = getRedis();
  if (!client) return memoryQueue.length;
  try {
    return await client.llen(QUEUE_KEY);
  } catch {
    return memoryQueue.length;
  }
};

/**
 * Returns anything left in processing to the queue. Worth calling on boot: it
 * picks up jobs a previous worker had claimed when it died.
 */
const recoverStranded = async () => {
  const client = getRedis();
  if (!client) return 0;
  let recovered = 0;
  try {
    for (;;) {
      const raw = await client.rpoplpush(PROCESSING_KEY, QUEUE_KEY);
      if (!raw) break;
      recovered += 1;
    }
    if (recovered > 0) {
      console.log(`[MailQueue] Recovered ${recovered} stranded job(s) from a previous run`);
    }
  } catch (err) {
    console.error('[MailQueue] Could not recover stranded jobs:', err.message);
  }
  return recovered;
};

module.exports = {
  enqueueMail,
  getQueueDepth,
  processQueue,
  recoverStranded,
};
