'use strict';

const { prisma } = require('../lib/prisma');
const courierRepository = require('../repositories/courier.repository');
const auditLogLogic = require('./audit_log.logic');
const { buildReport, assertDeletable, lockForDelete } = require('../utils/dependents');

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

/** Audit failures must never roll back the operation they describe. */
const audit = (actorUserId, action, details) => {
  if (!actorUserId) return Promise.resolve(null);
  return auditLogLogic
    .createAuditLog(actorUserId, action, details)
    .catch((err) => console.error(`Audit log error (${action}):`, err.message));
};

const withStatus = (message, status) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

/**
 * The couriers seeded on boot, so a fresh install can take a manifest at once.
 *
 * Regexes are deliberately null: a wrong pattern rejects valid boxes, so each is
 * added only once a real label proves it. The URL templates carry {tracking}
 * where the courier's site accepts a deep link; Evri and Royal Mail do not, so
 * the UI copies the number and opens their search page instead.
 */
const DEFAULT_COURIERS = [
  { code: 'DPD', name: 'DPD', trackingUrlTemplate: 'https://track.dpd.co.uk/search?reference={tracking}' },
  { code: 'DHL', name: 'DHL Express', trackingUrlTemplate: 'https://www.dhl.com/gb-en/home/tracking.html?submit=1&tracking-id={tracking}' },
  { code: 'FEDEX', name: 'FedEx', trackingUrlTemplate: 'https://www.fedex.com/fedextrack/?trknbr={tracking}' },
  { code: 'UPS', name: 'UPS', trackingUrlTemplate: 'https://www.ups.com/track?tracknum={tracking}' },
  { code: 'EVRI', name: 'Evri', trackingUrlTemplate: 'https://www.evri.com/track-a-parcel' },
  { code: 'ROYALMAIL', name: 'Royal Mail', trackingUrlTemplate: 'https://www.royalmail.com/track-your-item' },
];

const ensureDefaultCouriers = async () => {
  for (const spec of DEFAULT_COURIERS) {
    const existing = await courierRepository.getCourierByCode(spec.code);
    if (existing) continue;
    await courierRepository.createCourier({
      code: spec.code,
      name: spec.name,
      trackingRegex: null,
      trackingUrlTemplate: spec.trackingUrlTemplate,
    });
  }
};

/** Codes are uppercased and compact, so UPS and ups are the same courier. */
const normaliseCode = (raw) => {
  const code = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!code) throw new Error('A courier code is required.');
  if (code.length > 30) throw new Error('Courier code is too long — 30 characters maximum.');
  return code;
};

/** A regex a wrong pattern cannot crash the server with. Stored as given. */
const validateRegex = (raw) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const pattern = String(raw).trim();
  if (pattern.length > 255) throw new Error('Tracking pattern is too long — 255 characters maximum.');
  try {
    new RegExp(pattern);
  } catch {
    throw new Error('That tracking pattern is not a valid regular expression.');
  }
  return pattern;
};

const normaliseName = (raw, { required = true, label = 'Name' } = {}) => {
  const name = String(raw ?? '').trim();
  if (!name) {
    if (required) throw new Error(`${label} is required.`);
    return undefined;
  }
  return name;
};

const createCourier = async (data, actorUserId) => {
  const code = normaliseCode(data.code);
  const name = normaliseName(data.name, { label: 'Courier name' });
  const trackingRegex = validateRegex(data.trackingRegex);
  const trackingUrlTemplate = data.trackingUrlTemplate
    ? String(data.trackingUrlTemplate).trim().slice(0, 255)
    : null;

  const existing = await courierRepository.getCourierByCode(code);
  if (existing) throw new Error(`A courier with the code ${code} already exists.`);

  const courier = await courierRepository.createCourier({
    code,
    name,
    trackingRegex,
    trackingUrlTemplate,
  });
  await audit(actorUserId, 'COURIER_CREATED', { courierId: courier.id, code });
  return courier;
};

const updateCourier = async (id, data, actorUserId) => {
  const courier = await courierRepository.getCourierById(id);
  if (!courier) throw withStatus('Courier not found.', 404);

  const patch = {};
  if ('name' in data) patch.name = normaliseName(data.name, { label: 'Courier name' });
  if ('trackingRegex' in data) patch.trackingRegex = validateRegex(data.trackingRegex);
  if ('trackingUrlTemplate' in data) {
    patch.trackingUrlTemplate = data.trackingUrlTemplate
      ? String(data.trackingUrlTemplate).trim().slice(0, 255)
      : null;
  }
  if ('isActive' in data) patch.isActive = Boolean(data.isActive);
  if ('code' in data) {
    const code = normaliseCode(data.code);
    if (code !== courier.code) {
      const clash = await courierRepository.getCourierByCode(code);
      if (clash) throw new Error(`A courier with the code ${code} already exists.`);
      patch.code = code;
    }
  }

  if (Object.keys(patch).length === 0) throw new Error('Nothing to update.');

  const updated = await courierRepository.updateCourier(id, patch);
  await audit(actorUserId, 'COURIER_UPDATED', { courierId: id, changed: Object.keys(patch) });
  return updated;
};

const getCourierDependents = async (id, tx) => {
  const courier = await courierRepository.getCourierById(id, tx);
  if (!courier) throw withStatus('Courier not found.', 404);

  const [boxes, handovers] = await Promise.all([
    courierRepository.countCourierBoxes(id, tx),
    courierRepository.countCourierHandovers(id, tx),
  ]);

  return {
    courier,
    report: buildReport({
      blocking: [
        { key: 'boxes', label: 'Boxes on this courier', count: boxes, where: '/air-freight' },
        { key: 'handovers', label: 'Courier handovers', count: handovers, where: '/air-freight' },
      ],
    }),
  };
};

const deleteCourier = async (id, actorUserId) => {
  await prisma.$transaction(async (tx) => {
    await lockForDelete(tx, 'couriers', id);
    const { courier, report } = await getCourierDependents(id, tx);
    assertDeletable(courier.name, report, { deactivatable: true });
    await courierRepository.deleteCourier(id, tx);
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'COURIER_DELETED', { courierId: id });
  return { message: 'Courier deleted successfully.' };
};

const listCouriers = (options) => courierRepository.listCouriers(options);

// ─── Depots ─────────────────────────────────────────────────────────────────

const addDepot = async (courierId, data, actorUserId) => {
  const courier = await courierRepository.getCourierById(courierId);
  if (!courier) throw withStatus('Courier not found.', 404);

  const name = normaliseName(data.name, { label: 'Depot name' });
  const address = data.address ? String(data.address).trim() : null;

  const depot = await courierRepository.createDepot({ courierId, name, address });
  await audit(actorUserId, 'COURIER_UPDATED', { courierId, addedDepot: depot.id });
  return depot;
};

const updateDepot = async (depotId, data, actorUserId) => {
  const depot = await courierRepository.getDepotById(depotId);
  if (!depot) throw withStatus('Depot not found.', 404);

  const patch = {};
  if ('name' in data) patch.name = normaliseName(data.name, { label: 'Depot name' });
  if ('address' in data) patch.address = data.address ? String(data.address).trim() : null;
  if ('isActive' in data) patch.isActive = Boolean(data.isActive);
  if (Object.keys(patch).length === 0) throw new Error('Nothing to update.');

  const updated = await courierRepository.updateDepot(depotId, patch);
  await audit(actorUserId, 'COURIER_UPDATED', { depotId, changed: Object.keys(patch) });
  return updated;
};

const deleteDepot = async (depotId, actorUserId) => {
  const depot = await courierRepository.getDepotById(depotId);
  if (!depot) throw withStatus('Depot not found.', 404);

  const used = await courierRepository.countDepotHandovers(depotId);
  if (used > 0) {
    // A handover points at this depot (SetNull keeps the record), so keep the
    // name resolvable by deactivating rather than deleting.
    const updated = await courierRepository.updateDepot(depotId, { isActive: false });
    await audit(actorUserId, 'COURIER_UPDATED', { depotId, deactivated: true });
    return { message: 'Depot has handovers, so it was deactivated rather than deleted.', depot: updated };
  }

  await courierRepository.deleteDepot(depotId);
  await audit(actorUserId, 'COURIER_UPDATED', { depotId, deleted: true });
  return { message: 'Depot deleted successfully.' };
};

module.exports = {
  ensureDefaultCouriers,
  createCourier,
  updateCourier,
  deleteCourier,
  getCourierDependents,
  listCouriers,
  addDepot,
  updateDepot,
  deleteDepot,
  // Exported for tests.
  normaliseCode,
  validateRegex,
  DEFAULT_COURIERS,
};
