'use strict';

const settingsRepository = require('../repositories/air_freight_settings.repository');
const { prisma } = require('../lib/prisma');
const auditLogLogic = require('./audit_log.logic');

/**
 * Per-client air freight billing and notification settings.
 *
 * A client with no row uses these defaults — reading never requires a row to
 * exist. Every value a single price cannot express lives here: how chargeable
 * weight is worked out, the volumetric divisor and rounding, the free storage
 * time, and whether the client is emailed on milestones.
 */
const DEFAULTS = Object.freeze({
  chargeableWeightMethod: 'PER_BOX',
  volumetricDivisor: 6000,
  roundingIncrementKg: 0.5,
  freeStorageHours: 48,
  emailNotifications: false,
  notificationEmail: null,
});

const WEIGHT_METHODS = ['PER_BOX', 'FLIGHT_TOTAL'];
const ROUNDING_VALUES = [0, 0.5, 1];

const audit = (actorUserId, action, details) => {
  if (!actorUserId) return Promise.resolve(null);
  return auditLogLogic
    .createAuditLog(actorUserId, action, details)
    .catch((err) => console.error(`Audit log error (${action}):`, err.message));
};

/** The client's settings as plain numbers, falling back to the defaults. */
const getSettings = async (clientId, tx) => {
  const row = await settingsRepository.getByClientId(clientId, tx);
  if (!row) return { clientId, ...DEFAULTS, isDefault: true };
  return {
    clientId,
    chargeableWeightMethod: row.chargeableWeightMethod,
    volumetricDivisor: row.volumetricDivisor,
    roundingIncrementKg: Number(row.roundingIncrementKg),
    freeStorageHours: row.freeStorageHours,
    emailNotifications: row.emailNotifications,
    notificationEmail: row.notificationEmail,
    isDefault: false,
  };
};

const validate = (data) => {
  const patch = {};

  if ('chargeableWeightMethod' in data) {
    const method = String(data.chargeableWeightMethod);
    if (!WEIGHT_METHODS.includes(method)) {
      throw new Error(`Chargeable weight method must be one of: ${WEIGHT_METHODS.join(', ')}.`);
    }
    patch.chargeableWeightMethod = method;
  }

  if ('volumetricDivisor' in data) {
    const divisor = Number(data.volumetricDivisor);
    if (!Number.isInteger(divisor) || divisor < 1000 || divisor > 10_000) {
      throw new Error('Volumetric divisor must be a whole number between 1000 and 10000.');
    }
    patch.volumetricDivisor = divisor;
  }

  if ('roundingIncrementKg' in data) {
    const inc = Number(data.roundingIncrementKg);
    if (!ROUNDING_VALUES.includes(inc)) {
      throw new Error('Weight rounding must be 0, 0.5 or 1 kg.');
    }
    patch.roundingIncrementKg = inc;
  }

  if ('freeStorageHours' in data) {
    const hours = Number(data.freeStorageHours);
    if (!Number.isInteger(hours) || hours < 0 || hours > 720) {
      throw new Error('Free storage hours must be a whole number between 0 and 720.');
    }
    patch.freeStorageHours = hours;
  }

  if ('emailNotifications' in data) {
    patch.emailNotifications = Boolean(data.emailNotifications);
  }

  if ('notificationEmail' in data) {
    const email = data.notificationEmail ? String(data.notificationEmail).trim() : null;
    if (email && (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      throw new Error('Notification email is not a valid email address.');
    }
    patch.notificationEmail = email;
  }

  return patch;
};

const updateSettings = async (clientId, data, actorUserId) => {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) {
    const error = new Error('Client not found.');
    error.status = 404;
    throw error;
  }

  const patch = validate(data);
  if (Object.keys(patch).length === 0) throw new Error('Nothing to update.');

  await settingsRepository.upsert(clientId, { ...patch, updatedByUserId: actorUserId });
  await audit(actorUserId, 'AIR_FREIGHT_SETTINGS_UPDATED', {
    clientId,
    changed: Object.keys(patch),
  });

  return await getSettings(clientId);
};

module.exports = { DEFAULTS, getSettings, updateSettings };
