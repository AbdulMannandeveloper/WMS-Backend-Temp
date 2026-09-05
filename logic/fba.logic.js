'use strict';

/**
 * FBA consignments.
 *
 * A separate flow from ordinary shipments, and deliberately a much smaller one:
 * goods arrive, they are recorded by hand, they leave. Nothing is scanned,
 * nothing is put away, no stock level moves and no ledger entry is written,
 * because the goods were never in our inventory to begin with — they pass
 * through. What is billed is the passing through, per item, when they go.
 *
 * The state machine is explicit for the same reason it is on Shipment: status
 * being a settable field is what once let a shipment be moved to DISPATCHED
 * without any of the work dispatch is supposed to do.
 */

const fbaRepository = require('../repositories/fba.repository');
const invoiceLineItemRepository = require('../repositories/invoice_line_item.repository');
const clientRepository = require('../repositories/client.repository');
const auditLogLogic = require('./audit_log.logic');
const { getFbaRateForClient, resolveOpenInvoiceFor } = require('./billing_services');
const { prisma } = require('../lib/prisma');

const FBA_TRANSITIONS = {
  RECEIVED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: [],
  CANCELLED: [],
};

const assertTransition = (from, to) => {
  const allowed = FBA_TRANSITIONS[from];
  if (!allowed) throw new Error(`Consignment has an unrecognised status: ${from}.`);
  if (!allowed.includes(to)) {
    const options = allowed.length ? allowed.join(', ') : 'nothing — it is final';
    throw new Error(
      `A ${from} consignment cannot become ${to}. From ${from} you can move to: ${options}.`,
    );
  }
};

/** Audit failures must never roll back the operation they describe. */
const audit = (actorUserId, action, details) => {
  if (!actorUserId) return Promise.resolve(null);
  return auditLogLogic
    .createAuditLog(actorUserId, action, details)
    .catch((err) => console.error(`Audit log error (${action}):`, err.message));
};

// ─── Categories ───────────────────────────────────────────────────────────────

/**
 * Categories are set up before anything can be recorded — a consignment must
 * belong to one, so an empty category list is a deliberate first step rather
 * than an oversight.
 */
const addCategory = async ({ name }, actorUserId) => {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('A category name is required.');
  if (trimmed.length > 120) throw new Error('Category name is too long — 120 characters maximum.');

  const existing = await fbaRepository.getCategoryByName(trimmed);
  if (existing) throw new Error(`A category called "${trimmed}" already exists.`);

  const created = await fbaRepository.createCategory({ name: trimmed });
  await audit(actorUserId, 'FBA_CATEGORY_CREATED', { categoryId: created.id, name: trimmed });
  return created;
};

const getAllCategories = async () => await fbaRepository.getAllCategories();

const updateCategory = async (id, { name }, actorUserId) => {
  const category = await fbaRepository.getCategoryById(id);
  if (!category) throw new Error('Category not found.');

  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('A category name is required.');

  const clash = await fbaRepository.getCategoryByName(trimmed);
  if (clash && clash.id !== id) throw new Error(`A category called "${trimmed}" already exists.`);

  const updated = await fbaRepository.updateCategory(id, { name: trimmed });
  await audit(actorUserId, 'FBA_CATEGORY_UPDATED', { categoryId: id, from: category.name, to: trimmed });
  return updated;
};

/**
 * Refused while consignments still reference it. Deleting would either orphan
 * their history or cascade it away, and both lose the record of what was
 * handled and billed.
 */
const deleteCategory = async (id, actorUserId) => {
  const category = await fbaRepository.getCategoryById(id);
  if (!category) throw new Error('Category not found.');

  const inUse = await fbaRepository.countShipmentsInCategory(id);
  if (inUse > 0) {
    throw new Error(
      `"${category.name}" is used by ${inUse} consignment(s) and cannot be deleted.`,
    );
  }

  await fbaRepository.deleteCategory(id);
  await audit(actorUserId, 'FBA_CATEGORY_DELETED', { categoryId: id, name: category.name });
  return { message: 'Category deleted.' };
};

// ─── Consignments ─────────────────────────────────────────────────────────────

const requireShipment = async (id) => {
  const shipment = await fbaRepository.getShipmentById(id);
  if (!shipment) throw new Error('Consignment not found.');
  return shipment;
};

/** Records goods arriving. Everything is typed in; nothing is looked up. */
const recordArrival = async (data, actorUserId) => {
  const { categoryId, clientId, barcode, size, count, notes } = data;

  if (!categoryId) throw new Error('A category is required.');
  if (!clientId) throw new Error('A client is required.');

  const barcodeValue = String(barcode ?? '').replace(/\s+/g, '');
  if (!barcodeValue) throw new Error('A barcode is required.');
  if (barcodeValue.length > 64) throw new Error('Barcode is too long — 64 characters maximum.');

  const sizeValue = String(size ?? '').trim();
  if (!sizeValue) throw new Error('A size is required.');
  if (sizeValue.length > 60) throw new Error('Size is too long — 60 characters maximum.');

  const countValue = Number(count);
  if (!Number.isInteger(countValue) || countValue <= 0) {
    throw new Error('Count must be a whole number above zero.');
  }

  const category = await fbaRepository.getCategoryById(categoryId);
  if (!category) throw new Error('That category does not exist.');

  const client = await clientRepository.getClientByField('id', clientId);
  if (!client) throw new Error('That client does not exist.');

  const created = await fbaRepository.createShipment({
    categoryId,
    clientId,
    barcode: barcodeValue,
    size: sizeValue,
    count: countValue,
    notes: notes ? String(notes) : null,
    status: 'RECEIVED',
  });

  await audit(actorUserId, 'FBA_SHIPMENT_RECEIVED', {
    fbaShipmentId: created.id,
    clientId,
    barcode: barcodeValue,
    count: countValue,
  });

  return created;
};

/**
 * Records goods leaving, and bills for them.
 *
 * The charge is count × the client's agreed FBA rate, frozen onto the line, so a
 * later rate change cannot rewrite what was already raised. A client with no FBA
 * rate is simply not charged — the same treatment as a client with no dispatch
 * rate, and a real arrangement rather than an error.
 */
const recordDispatch = async (id, actorUserId) => {
  const shipment = await requireShipment(id);
  assertTransition(shipment.status, 'DISPATCHED');

  return await prisma.$transaction(async (tx) => {
    const dispatchedAt = new Date();

    const updated = await fbaRepository.updateShipment(
      id,
      { status: 'DISPATCHED', dispatchedAt },
      tx,
    );

    const rate = await getFbaRateForClient(shipment.clientId, tx);
    const unitPrice = rate ? Number(rate.unitPrice) : 0;

    if (rate && unitPrice > 0) {
      const invoice = await resolveOpenInvoiceFor(shipment.clientId, tx);

      await invoiceLineItemRepository.createInvoiceLineItem(
        {
          invoiceId: invoice.id,
          clientServiceId: rate.clientService.id,
          quantity: shipment.count,
          unitPrice,
          totalPrice: Number((shipment.count * unitPrice).toFixed(2)),
          description: `FBA consignment — ${shipment.count} item(s), ${shipment.category?.name ?? 'uncategorised'}, barcode ${shipment.barcode}`,
          dateOfService: dispatchedAt,
          itemType: 'FBA_CHARGE',
        },
        tx,
      );

      // Derived from the lines, never accumulated here.
      const { _sum } = await tx.invoiceLineItem.aggregate({
        where: { invoiceId: invoice.id },
        _sum: { totalPrice: true },
      });
      await tx.monthlyInvoice.update({
        where: { id: invoice.id },
        data: { totalAmount: _sum.totalPrice ?? 0 },
      });
    }

    await audit(actorUserId, 'FBA_SHIPMENT_DISPATCHED', {
      fbaShipmentId: id,
      clientId: shipment.clientId,
      count: shipment.count,
      charged: rate ? Number((shipment.count * unitPrice).toFixed(2)) : null,
    });

    return updated;
  });
};

/** For a mis-key. Refused once dispatched, because it has already been billed. */
const cancel = async (id, reason, actorUserId) => {
  const shipment = await requireShipment(id);
  assertTransition(shipment.status, 'CANCELLED');

  const updated = await fbaRepository.updateShipment(id, { status: 'CANCELLED' });
  await audit(actorUserId, 'FBA_SHIPMENT_CANCELLED', { fbaShipmentId: id, reason: reason ?? null });
  return updated;
};

/**
 * Hard-deletes a consignment, for one recorded that was never really here.
 *
 * Refused once DISPATCHED, mirroring deleteShipment on the outbound side: that
 * is the moment the client was charged, and the invoice line naming this
 * consignment's barcode would be left describing a row that no longer exists.
 * Cancel is not available then either — the state machine makes DISPATCHED
 * final — so the answer at that point is a credit, not a deletion.
 *
 * Nothing depends on FbaShipment, so nothing cascades away with it.
 */
const remove = async (id, actorUserId) => {
  const shipment = await requireShipment(id);

  if (shipment.status === 'DISPATCHED') {
    const client = shipment.client?.companyName ?? 'the client';
    throw new Error(
      `This consignment was dispatched and billed to ${client}. It cannot be deleted — credit the invoice instead.`,
    );
  }

  const deleted = await fbaRepository.deleteShipment(id);
  await audit(actorUserId, 'FBA_SHIPMENT_DELETED', {
    fbaShipmentId: id,
    clientId: shipment.clientId,
    barcode: shipment.barcode,
    count: shipment.count,
    status: shipment.status,
  });
  return deleted;
};

const getAllShipments = async () => await fbaRepository.getAllShipments();
const getShipmentsByClientId = async (clientId) =>
  await fbaRepository.getShipmentsByClientId(clientId);
const getShipmentById = async (id) => await requireShipment(id);

module.exports = {
  addCategory,
  getAllCategories,
  updateCategory,
  deleteCategory,
  recordArrival,
  recordDispatch,
  cancel,
  remove,
  getAllShipments,
  getShipmentsByClientId,
  getShipmentById,
  FBA_TRANSITIONS,
  assertTransition,
};
