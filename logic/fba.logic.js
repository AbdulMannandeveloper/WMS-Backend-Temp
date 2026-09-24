'use strict';

/**
 * Bulk shipments (held on the FBA model, labelled "Bulk Shipment" in the UI).
 *
 * A three-step flow, each step its own action so one, two or three different
 * people can carry them out:
 *
 *   1. create   — someone opens a bulk shipment for a client, choosing a
 *                 category (box/pallet), destination, delivery note and
 *                 tracking number. It gets a BULK-YYYY-NNNNNN reference and
 *                 starts in DRAFT.
 *   2. prepare  — someone scans products into it with quantities. Each line
 *                 reserves its stock so it cannot be committed elsewhere while
 *                 the shipment sits waiting. Status becomes PREPARING.
 *   3. dispatch — someone sends it. The reserved stock is checked out (a real
 *                 inventory movement, unlike the old pass-through FBA), and the
 *                 client is charged their single Bulk Shipment rate × the total
 *                 units shipped.
 *
 * Status is a state machine here rather than a settable field, the same reason
 * it is on Shipment: a settable status is what once let goods "dispatch" without
 * the stock and billing dispatch is supposed to do.
 *
 * RECEIVED is the legacy single-step status; old rows keep it and can still be
 * dispatched or cancelled.
 */

const fbaRepository = require('../repositories/fba.repository');
const invoiceLineItemRepository = require('../repositories/invoice_line_item.repository');
const clientRepository = require('../repositories/client.repository');
const stockLevelRepository = require('../repositories/stock_level.repository');
const inventoryLedgerLogic = require('./inventory_ledger.logic');
const auditLogLogic = require('./audit_log.logic');
const { getFbaRateForClient, resolveOpenInvoiceFor } = require('./billing_services');
const { prisma } = require('../lib/prisma');

const FBA_TRANSITIONS = {
  DRAFT: ['PREPARING', 'CANCELLED'],
  PREPARING: ['DISPATCHED', 'DRAFT', 'CANCELLED'],
  RECEIVED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: [],
  CANCELLED: [],
};

const assertTransition = (from, to) => {
  const allowed = FBA_TRANSITIONS[from];
  if (!allowed) throw new Error(`Bulk shipment has an unrecognised status: ${from}.`);
  if (!allowed.includes(to)) {
    const options = allowed.length ? allowed.join(', ') : 'nothing — it is final';
    throw new Error(
      `A ${from} bulk shipment cannot become ${to}. From ${from} you can move to: ${options}.`,
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

const countUnits = (items) =>
  items.reduce((total, item) => total + Number(item.quantity || 0), 0);

// ─── Categories (box / pallet labels — no price) ────────────────────────────────

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

const deleteCategory = async (id, actorUserId) => {
  const category = await fbaRepository.getCategoryById(id);
  if (!category) throw new Error('Category not found.');

  const inUse = await fbaRepository.countShipmentsInCategory(id);
  if (inUse > 0) {
    throw new Error(
      `"${category.name}" is used by ${inUse} bulk shipment(s) and cannot be deleted.`,
    );
  }

  await fbaRepository.deleteCategory(id);
  await audit(actorUserId, 'FBA_CATEGORY_DELETED', { categoryId: id, name: category.name });
  return { message: 'Category deleted.' };
};

// ─── The bulk-shipment reference ────────────────────────────────────────────────
// BULK-<year>-<sequence>, generated the same way as Shipment.reference.

const REFERENCE_PREFIX = 'BULK';
const REFERENCE_DIGITS = 6;
const REFERENCE_ATTEMPTS = 5;
const REFERENCE_SCAN = 10;

const referenceSeriesFor = (date) => `${REFERENCE_PREFIX}-${date.getUTCFullYear()}-`;

const nextBulkReference = async (tx) => {
  const series = referenceSeriesFor(new Date());
  const recent = await fbaRepository.getLatestReferencesInSeries(series, REFERENCE_SCAN, tx);

  let last = 0;
  for (const row of recent) {
    const tail = row.reference.slice(series.length);
    if (!/^\d+$/.test(tail)) continue;
    last = Number.parseInt(tail, 10);
    break;
  }

  return `${series}${String(last + 1).padStart(REFERENCE_DIGITS, '0')}`;
};

const isReferenceClash = (error) => {
  if (error?.code !== 'P2002') return false;
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some((f) => String(f ?? '').includes('reference'));
};

// ─── Consignments ─────────────────────────────────────────────────────────────

const requireShipment = async (id) => {
  const shipment = await fbaRepository.getShipmentById(id);
  if (!shipment) throw new Error('Bulk shipment not found.');
  return shipment;
};

/** Step 1: open an empty bulk shipment. */
const createBulkShipment = async (data, actorUserId) => {
  const { clientId, categoryId, destination, deliveryNote, trackingId } = data;

  if (!clientId) throw new Error('A client is required.');
  if (!categoryId) throw new Error('A category is required.');

  const category = await fbaRepository.getCategoryById(categoryId);
  if (!category) throw new Error('That category does not exist.');

  const client = await clientRepository.getClientByField('id', clientId);
  if (!client) throw new Error('That client does not exist.');

  const shell = {
    categoryId,
    clientId,
    destination: destination ? String(destination).trim().slice(0, 160) : null,
    deliveryNote: deliveryNote ? String(deliveryNote) : null,
    trackingId: trackingId ? String(trackingId).trim().slice(0, 64) : null,
    status: 'DRAFT',
    createdByUserId: actorUserId ?? null,
  };

  // Reference is issued inside the transaction and retried on the one unique
  // clash it can hit — two creates picking the same number at once.
  for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt += 1) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const reference = await nextBulkReference(tx);
        return await fbaRepository.createShipment({ ...shell, reference }, tx);
      });
      await audit(actorUserId, 'FBA_SHIPMENT_CREATED', {
        fbaShipmentId: created.id,
        reference: created.reference,
        clientId,
      });
      return created;
    } catch (err) {
      if (isReferenceClash(err) && attempt < REFERENCE_ATTEMPTS - 1) continue;
      throw err;
    }
  }
  // Unreachable: the loop returns or throws.
  throw new Error('Could not issue a bulk shipment reference. Please try again.');
};

const normaliseLines = (raw) => {
  if (!Array.isArray(raw)) throw new Error('Products must be a list.');
  return raw.map((line, i) => {
    const productId = line.productId;
    const sourceLocationId = line.sourceLocationId;
    const quantity = Number(line.quantity);
    if (!productId) throw new Error(`Line ${i + 1}: a product is required.`);
    if (!sourceLocationId) throw new Error(`Line ${i + 1}: a source location is required.`);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`Line ${i + 1}: quantity must be a whole number above zero.`);
    }
    return {
      productId,
      sourceLocationId,
      quantity,
      barcode: line.barcode ? String(line.barcode) : null,
    };
  });
};

/**
 * Step 2: set the products on a bulk shipment (scan → quantity).
 *
 * Replaces the whole line set, so the prepare screen sends the basket as it
 * stands. Every line reserves its stock; the previous lines' reservations are
 * handed back first, so re-preparing nets correctly. An empty set drops the
 * shipment back to DRAFT.
 */
const setBulkItems = async (id, rawLines, actorUserId) => {
  const shipment = await requireShipment(id);
  if (!['DRAFT', 'PREPARING'].includes(shipment.status)) {
    throw new Error(
      `Products can only be added while a bulk shipment is being prepared — this one is ${shipment.status}.`,
    );
  }

  const lines = normaliseLines(rawLines);

  return await prisma.$transaction(async (tx) => {
    // Hand back what the current lines reserved, then clear them.
    const existing = await fbaRepository.getItemsByShipment(id, tx);
    for (const item of existing) {
      const stock = await stockLevelRepository.getStockLevelByProductAndLocation(
        item.productId,
        item.sourceLocationId,
        tx,
      );
      if (stock) {
        await stockLevelRepository.releaseReservedStockAtomically(stock.id, item.quantity, tx);
      }
    }
    await fbaRepository.deleteItemsByShipment(id, tx);

    // Reserve and record the new lines.
    for (const line of lines) {
      const stock = await stockLevelRepository.getStockLevelByProductAndLocation(
        line.productId,
        line.sourceLocationId,
        tx,
      );
      if (!stock) {
        throw new Error('That product has no stock record at the chosen location.');
      }
      const reserved = await stockLevelRepository.reserveStockAtomically(
        stock.id,
        line.quantity,
        tx,
      );
      if (reserved === 0) {
        throw new Error(
          `Not enough available stock to reserve ${line.quantity} unit(s) at that location.`,
        );
      }
      await fbaRepository.createItem(
        {
          fbaShipmentId: id,
          productId: line.productId,
          quantity: line.quantity,
          sourceLocationId: line.sourceLocationId,
          barcode: line.barcode,
        },
        tx,
      );
    }

    const nextStatus = lines.length > 0 ? 'PREPARING' : 'DRAFT';
    const updated = await fbaRepository.updateShipment(
      id,
      { status: nextStatus, preparedByUserId: actorUserId ?? null },
      tx,
    );

    await audit(actorUserId, 'FBA_SHIPMENT_PREPARED', {
      fbaShipmentId: id,
      lineCount: lines.length,
      units: lines.reduce((sum, l) => sum + l.quantity, 0),
    });

    return updated;
  });
};

/**
 * Step 3: dispatch. Checks the reserved stock out (a real CHECKOUT movement,
 * against this shipment's reference) and bills the client their single Bulk
 * Shipment rate × total units. A client with no rate is not charged.
 */
const dispatchBulk = async (id, actorUserId) => {
  const shipment = await requireShipment(id);
  assertTransition(shipment.status, 'DISPATCHED');

  const items = shipment.items || [];
  if (items.length === 0) {
    throw new Error('A bulk shipment cannot be dispatched with no products added.');
  }

  return await prisma.$transaction(async (tx) => {
    const dispatchedAt = new Date();

    // Status first, so the CHECKOUT ledger validation below sees this shipment
    // as DISPATCHED when it looks it up by reference.
    const updated = await fbaRepository.updateShipment(
      id,
      { status: 'DISPATCHED', dispatchedAt, dispatchedByUserId: actorUserId ?? null },
      tx,
    );

    for (const item of items) {
      await inventoryLedgerLogic.createInventoryLedger(
        {
          productId: item.productId,
          userId: actorUserId,
          movementType: 'CHECKOUT',
          quantity: item.quantity,
          referenceId: shipment.reference,
          fromLocationId: item.sourceLocationId,
        },
        { tx },
      );
    }

    const totalUnits = countUnits(items);
    const rate = await getFbaRateForClient(shipment.clientId, tx);
    const unitPrice = rate ? Number(rate.unitPrice) : 0;
    let charged = null;

    if (rate && unitPrice > 0) {
      const invoice = await resolveOpenInvoiceFor(shipment.clientId, tx);

      await invoiceLineItemRepository.createInvoiceLineItem(
        {
          invoiceId: invoice.id,
          clientServiceId: rate.clientService.id,
          quantity: totalUnits,
          unitPrice,
          totalPrice: Number((totalUnits * unitPrice).toFixed(2)),
          description: `Bulk shipment ${shipment.reference} — ${totalUnits} unit(s) across ${items.length} product(s)`,
          dateOfService: dispatchedAt,
          itemType: 'FBA_CHARGE',
        },
        tx,
      );

      const { _sum } = await tx.invoiceLineItem.aggregate({
        where: { invoiceId: invoice.id },
        _sum: { totalPrice: true },
      });
      await tx.monthlyInvoice.update({
        where: { id: invoice.id },
        data: { totalAmount: _sum.totalPrice ?? 0 },
      });

      charged = Number((totalUnits * unitPrice).toFixed(2));
    }

    await audit(actorUserId, 'FBA_SHIPMENT_DISPATCHED', {
      fbaShipmentId: id,
      clientId: shipment.clientId,
      units: totalUnits,
      products: items.length,
      charged,
    });

    return updated;
  });
};

/** Voids a bulk shipment before dispatch, handing back any reserved stock. */
const cancel = async (id, reason, actorUserId) => {
  const shipment = await requireShipment(id);
  assertTransition(shipment.status, 'CANCELLED');

  return await prisma.$transaction(async (tx) => {
    // Only a PREPARING shipment holds reservations; DRAFT and legacy RECEIVED
    // hold none, so there is nothing to release for those.
    if (shipment.status === 'PREPARING') {
      const items = await fbaRepository.getItemsByShipment(id, tx);
      for (const item of items) {
        const stock = await stockLevelRepository.getStockLevelByProductAndLocation(
          item.productId,
          item.sourceLocationId,
          tx,
        );
        if (stock) {
          await stockLevelRepository.releaseReservedStockAtomically(stock.id, item.quantity, tx);
        }
      }
    }

    const updated = await fbaRepository.updateShipment(id, { status: 'CANCELLED' }, tx);
    await audit(actorUserId, 'FBA_SHIPMENT_CANCELLED', { fbaShipmentId: id, reason: reason ?? null });
    return updated;
  });
};

/**
 * Hard-deletes a bulk shipment. Refused once DISPATCHED — that is when the stock
 * moved and the client was billed, so the answer then is a credit, not a delete.
 * Any reservation a PREPARING shipment still holds is handed back first; its
 * item rows cascade with it.
 */
const remove = async (id, actorUserId) => {
  const shipment = await requireShipment(id);

  if (shipment.status === 'DISPATCHED') {
    const client = shipment.client?.companyName ?? 'the client';
    throw new Error(
      `This bulk shipment was dispatched and billed to ${client}. It cannot be deleted — credit the invoice instead.`,
    );
  }

  return await prisma.$transaction(async (tx) => {
    if (shipment.status === 'PREPARING') {
      const items = await fbaRepository.getItemsByShipment(id, tx);
      for (const item of items) {
        const stock = await stockLevelRepository.getStockLevelByProductAndLocation(
          item.productId,
          item.sourceLocationId,
          tx,
        );
        if (stock) {
          await stockLevelRepository.releaseReservedStockAtomically(stock.id, item.quantity, tx);
        }
      }
    }

    const deleted = await fbaRepository.deleteShipment(id, tx);
    await audit(actorUserId, 'FBA_SHIPMENT_DELETED', {
      fbaShipmentId: id,
      reference: shipment.reference,
      clientId: shipment.clientId,
      status: shipment.status,
    });
    return deleted;
  });
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
  createBulkShipment,
  setBulkItems,
  dispatchBulk,
  cancel,
  remove,
  getAllShipments,
  getShipmentsByClientId,
  getShipmentById,
  FBA_TRANSITIONS,
  assertTransition,
};
