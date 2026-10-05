'use strict';

// TESTING-ONLY (whole file) — delete it with the rest; see TESTING_RELAXATIONS.md.

/**
 * The switch for the deletes allowed while the company tests on live data.
 *
 * An admin turns it on from the app; it then runs for a week and goes off on
 * its own. They can turn it off sooner, and on again for another week. While
 * on, the moment it was turned on is a row in the settings table; off, there
 * is no row. Read from the database on every check, so every worker sees the
 * same switch the moment it changes.
 */

const { prisma } = require('../lib/prisma');
const auditLogLogic = require('./audit_log.logic');

const STARTED_AT_KEY = 'TESTING_DELETES_STARTED_AT';
const RUNS_FOR_MS = 7 * 24 * 60 * 60 * 1000;

const OFF = { enabled: false, expired: false, startedAt: null, until: null };

/**
 * Whether testing deletes are on.
 *
 * @param {{ now?: Date, tx?: object }} [options]  `tx` to read inside a transaction
 * @returns {Promise<{ enabled: boolean, expired: boolean, startedAt: string | null, until: string | null }>}
 *   `expired`: turned on, but its week is over — still shown to admins, as the
 *   reminder to remove this code, until one dismisses it.
 */
const testingDeletesStatus = async ({ now = new Date(), tx } = {}) => {
  const row = await (tx ?? prisma).setting.findUnique({ where: { key: STARTED_AT_KEY } });
  const startedAt = row ? new Date(row.value) : null;
  if (!startedAt || Number.isNaN(startedAt.getTime())) return OFF;
  const end = new Date(startedAt.getTime() + RUNS_FOR_MS);
  const expired = now >= end;
  return { enabled: !expired, expired, startedAt: startedAt.toISOString(), until: end.toISOString() };
};

/** Whether the testing-only deletes are allowed right now. */
const testingDeletesEnabled = async (options) => (await testingDeletesStatus(options)).enabled;

const audit = (actorUserId, action, details) =>
  auditLogLogic
    .createAuditLog(actorUserId, action, details)
    .catch((err) => console.error('Audit log error:', err.message));

/**
 * Turns testing deletes on for a week from now. Already on, it changes
 * nothing: the week is not extended by pressing it again.
 */
const turnOnTestingDeletes = async (actorUserId, now = new Date()) => {
  const current = await testingDeletesStatus({ now });
  if (current.enabled) return current;
  await prisma.setting.upsert({
    where: { key: STARTED_AT_KEY },
    create: { key: STARTED_AT_KEY, value: now.toISOString(), updatedById: actorUserId ?? null },
    update: { value: now.toISOString(), updatedById: actorUserId ?? null },
  });
  const status = await testingDeletesStatus({ now });
  await audit(actorUserId, 'TESTING_MODE_ON', { until: status.until });
  return status;
};

/** Turns testing deletes off (or dismisses an expired week). */
const turnOffTestingDeletes = async (actorUserId) => {
  const { count } = await prisma.setting.deleteMany({ where: { key: STARTED_AT_KEY } });
  if (count > 0) await audit(actorUserId, 'TESTING_MODE_OFF', {});
  return OFF;
};

/** Says so in the log at startup while it is on, for whoever reads the logs. */
const logTestingModeAtStartup = async () => {
  const { enabled, expired, until } = await testingDeletesStatus();
  if (enabled) {
    console.warn(
      `[Testing mode] ON until ${until}: admins can delete approved and paid invoices, ` +
        'single pay records, dispatched products and received freight. See TESTING_RELAXATIONS.md.',
    );
  } else if (expired) {
    console.warn(`[Testing mode] Ended ${until}. Remove the testing-only code (TESTING_RELAXATIONS.md).`);
  }
};

module.exports = {
  RUNS_FOR_MS,
  testingDeletesStatus,
  testingDeletesEnabled,
  turnOnTestingDeletes,
  turnOffTestingDeletes,
  logTestingModeAtStartup,
};
