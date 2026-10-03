'use strict';

/**
 * Bulk shipments (held on the FBA model, labelled "Bulk Shipment" in the UI).
 *
 * A three-step flow, each step its own action so one, two or three different
 * people can carry them out:
 *
 *   1. create   — the office opens a bulk shipment for a client, choosing a
 *                 category (box/pallet), the delivery details (destination,
 *                 address, mode of dispatch, tracking...), a note for staff,
 *                 the products and quantities to send and any extra services.
 *                 Each line reserves its stock straight away. It gets a
 *                 BULK-YYYY-NNNNNN reference and starts in PREPARING (DRAFT if
 *                 sent empty). Its delivery note can be printed from here on.
 *   2. pick     — the floor scans each product against that plan. Picks are
 *                 counted per line and scanning never exceeds what is planned.
 *                 The plan can still change (setBulkItems): a line cut below
 *                 what is picked, or dropped, keeps its picked goods on record
 *                 as "to put back", and a new line starts unpicked.
 *   3. dispatch — someone sends it, but only once every line's picked count
 *                 matches its plan exactly — nothing short, nothing to put back.
 *                 The reserved stock is checked out (a real inventory movement)
 *                 and the client is charged their single Bulk Shipment rate ×
 *                 the total units shipped, plus each attached service — every
 *                 price read at that moment, since that is when it is charged.
 *
 * Status is a state machine here rather than a settable field, the same reason
 * it is on Shipment: a settable status is what once let goods "dispatch" without
 * the stock and billing dispatch is supposed to do.
 *
 * After dispatch: the tracking number can still be recorded (couriers usually
 * issue it then), goods that come back are returned line by line, and an admin
 * can delete it outright — its stock goes back and its charges come off the
 * invoice, unless that invoice is already paid.
 *
 * RECEIVED is the legacy single-step status; old rows keep it and can still be
 * dispatched or cancelled.
 */

const fbaRepository = require('../repositories/fba.repository');
const invoiceLineItemRepository = require('../repositories/invoice_line_item.repository');
const monthlyInvoiceRepository = require('../repositories/monthly_invoice.repository');
const clientRepository = require('../repositories/client.repository');
const stockLevelRepository = require('../repositories/stock_level.repository');
const inventoryLedgerLogic = require('./inventory_ledger.logic');
const auditLogLogic = require('./audit_log.logic');
const {
  getFbaRateForClient,
  resolveOpenInvoiceFor,
} = require('./billing_services');
const { renderDeliveryNotePdf } = require('../utils/deliveryNotePdf');
const { prisma } = require('../lib/prisma');
const { buildReport, assertDeletable } = require('../utils/dependents');
const { freeUnitsIn, takeOffShelf, paidAmong, removeChargeLines } = require('./reversal');

// Prisma's interactive-transaction default is 5s. Preparing a shipment does
// several round trips per line (find stock, reserve, insert) against a remote
// database, so a basket of any size overran it and rolled back mid-save.
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

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

/**
 * What deleting a category would refuse on: every bulk shipment filed under
 * it, of any status. A shipment cannot be without one, so they are moved to
 * another category (Edit on each) or deleted first.
 */
const getCategoryDependents = async (id) => {
  const category = await fbaRepository.getCategoryById(id);
  if (!category) throw new Error('Category not found.');
  const inUse = await fbaRepository.countShipmentsInCategory(id);
  return {
    category,
    report: buildReport({
      blocking: [
        {
          key: 'bulkShipments',
          label: 'Bulk shipments in it',
          count: inUse,
          where: '/fba',
          note: 'Move each to another category with Edit, or delete it.',
        },
      ],
    }),
  };
};

const deleteCategory = async (id, actorUserId) => {
  const { category, report } = await getCategoryDependents(id);
  assertDeletable(`"${category.name}"`, report);

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

/**
 * Locks the shipment row for the rest of the transaction and returns it as it
 * stands now. Picking, plan changes, client moves, voids, deletes and dispatch
 * all take this first, so a check on what has been picked cannot be overtaken
 * by a pick saved between the check and the write — the second waits.
 */
const lockShipment = async (id, tx) => {
  await tx.$queryRaw`SELECT id FROM fba_shipments WHERE id = ${id}::uuid FOR UPDATE`;
  const fresh = await fbaRepository.getShipmentById(id, tx);
  if (!fresh) throw new Error('Bulk shipment not found.');
  return fresh;
};

const pickedUnitsOf = (items) =>
  (items || []).reduce((sum, item) => sum + Number(item.pickedQuantity || 0), 0);

/** "SKU-1 × 4 to A-01", for telling someone exactly what to put back. */
const putBackList = (entries) =>
  entries
    .map(
      ({ item, units }) =>
        `${item.product?.skuCode ?? 'a product'} × ${units}${
          item.sourceLocation?.locationName ? ` to ${item.sourceLocation.locationName}` : ''
        }`,
    )
    .join(', ');

/**
 * Picked goods are off the shelf but still counted in their bin. Anything that
 * would drop their lines — voiding, deleting, moving client — is refused until
 * they are put back (a lowered count on the Pick screen), or nobody would be
 * told the bin is short.
 */
const assertNothingPicked = (shipment, refusal) => {
  const picked = (shipment.items || []).filter((item) => item.pickedQuantity > 0);
  if (picked.length === 0) return;
  throw new Error(
    `${refusal} while picked goods are off the shelf. Put them back first, on the Pick screen: ${putBackList(
      picked.map((item) => ({ item, units: item.pickedQuantity })),
    )}.`,
  );
};

// The free-text details a bulk shipment carries, most of them printed on its
// delivery note. [field, max length]; null means unbounded text.
const DETAIL_TEXT_FIELDS = [
  ['destination', 160],
  ['deliveryNote', null],
  ['trackingId', 64],
  ['dispatchMode', 80],
  ['staffNote', null],
  ['orderReference', 64],
  ['deliveryAddress', 1000],
  ['deliveryPostcode', 20],
  ['deliveryContact', 120],
  ['vehicleRegistration', 20],
];

const cleanText = (value, max) => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  return max ? trimmed.slice(0, max) : trimmed;
};

/** A count that may be left blank: null, or a whole number zero or above. */
const optionalCount = (value, label) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a whole number, zero or more.`);
  }
  return n;
};

/** The detail fields present in data. An empty value clears one. */
const readDetails = (data) => {
  const details = {};
  for (const [field, max] of DETAIL_TEXT_FIELDS) {
    if (data[field] !== undefined) details[field] = cleanText(data[field], max);
  }
  if (data.palletCount !== undefined) {
    details.palletCount = optionalCount(data.palletCount, 'Number of pallets');
  }
  return details;
};

const lineKey = (line) => `${line.productId}:${line.sourceLocationId}`;

/**
 * Validates submitted lines and folds repeats of the same product from the
 * same bin into one, so each (product, bin) has a single line to pick against.
 */
const normaliseLines = (raw) => {
  if (!Array.isArray(raw)) throw new Error('Products must be a list.');
  const merged = new Map();
  raw.forEach((line, i) => {
    const productId = line.productId;
    const sourceLocationId = line.sourceLocationId;
    const quantity = Number(line.quantity);
    if (!productId) throw new Error(`Line ${i + 1}: a product is required.`);
    if (!sourceLocationId) throw new Error(`Line ${i + 1}: a source location is required.`);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`Line ${i + 1}: quantity must be a whole number above zero.`);
    }
    // Zero boxes means nobody said, the same as blank.
    const boxes = optionalCount(line.boxes, `Line ${i + 1}: number of boxes`) || null;
    const key = lineKey({ productId, sourceLocationId });
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += quantity;
      existing.boxes = (existing.boxes ?? 0) + (boxes ?? 0) || null;
    } else {
      merged.set(key, {
        productId,
        sourceLocationId,
        quantity,
        boxes,
        barcode: line.barcode ? String(line.barcode) : null,
      });
    }
  });
  return [...merged.values()];
};

/**
 * A SKU is unique only within a client, so the server checks ownership too.
 * refusal words the error for the caller: adding a product and moving a whole
 * shipment to another client fail for the same reason but need different advice.
 */
const assertProductsBelongTo = async (
  clientId,
  lines,
  refusal = (sku) => `${sku} belongs to another client, so it cannot go on this shipment.`,
) => {
  if (lines.length === 0) return;
  const ids = [...new Set(lines.map((l) => l.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, clientId: true, skuCode: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const id of ids) {
    const product = byId.get(id);
    if (!product) throw new Error('One of the products does not exist.');
    if (product.clientId !== clientId) throw new Error(refusal(product.skuCode));
  }
};

/**
 * How much of a line's bin a shipment holds. Picked goods are off the shelf, so
 * they stay held whatever the plan says: a line holds the larger of what it
 * plans and what is picked. A voided shipment plans nothing any more, so it
 * holds only its picked goods, until they are put back.
 */
const heldFor = (item, status) =>
  status === 'CANCELLED'
    ? Number(item.pickedQuantity || 0)
    : Math.max(Number(item.quantity || 0), Number(item.pickedQuantity || 0));

const releaseHeld = async (item, units, tx) => {
  if (units <= 0) return;
  const stock = await stockLevelRepository.getStockLevelByProductAndLocation(
    item.productId,
    item.sourceLocationId,
    tx,
  );
  if (stock) await stockLevelRepository.releaseReservedStockAtomically(stock.id, units, tx);
};

/**
 * Reserves each line's stock and writes the line. pickedByKey and putBackByKey
 * carry a line's picks and put-back total across a change of plan. A line whose
 * picks now exceed its plan keeps them all — the extra is shown as to put back,
 * and dispatch waits for it.
 */
const reserveLines = async (fbaShipmentId, lines, pickedByKey, tx, putBackByKey = new Map()) => {
  for (const line of lines) {
    const picked = pickedByKey.get(lineKey(line)) ?? 0;
    const hold = Math.max(line.quantity, picked);
    const stock = await stockLevelRepository.getStockLevelByProductAndLocation(
      line.productId,
      line.sourceLocationId,
      tx,
    );
    if (!stock) {
      throw new Error('That product has no stock record at the chosen location.');
    }
    if (hold > 0) {
      const reserved = await stockLevelRepository.reserveStockAtomically(stock.id, hold, tx);
      if (reserved === 0) {
        throw new Error(`Not enough available stock to reserve ${hold} unit(s) at that location.`);
      }
    }
    await fbaRepository.createItem(
      {
        fbaShipmentId,
        productId: line.productId,
        quantity: line.quantity,
        pickedQuantity: picked,
        putBackQuantity: putBackByKey.get(lineKey(line)) ?? 0,
        boxes: line.boxes ?? null,
        sourceLocationId: line.sourceLocationId,
        barcode: line.barcode,
      },
      tx,
    );
  }
};

/**
 * Validates the services to attach. Only services the client has a rate for,
 * and never a system-raised one: the Bulk Shipment rate is charged on dispatch
 * already, and attaching it by hand would bill it twice. Not priced here — the
 * charge is raised on dispatch, at the rate in force then.
 */
const resolveServices = async (clientId, raw, alreadyAttached = new Set()) => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('Services must be a list.');

  const seen = new Set();
  const resolved = [];
  for (const [i, entry] of raw.entries()) {
    const serviceId = entry?.serviceId;
    const quantity = Number(entry?.quantity);
    if (!serviceId) throw new Error(`Service ${i + 1}: a service is required.`);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Service ${i + 1}: quantity must be above zero.`);
    }
    if (seen.has(serviceId)) {
      throw new Error('A service can only be added once — raise its quantity instead.');
    }
    seen.add(serviceId);

    const rate = await prisma.clientService.findFirst({
      where: { clientId, serviceId },
      include: { service: true },
    });
    if (!rate) {
      throw new Error(
        `Service ${i + 1} is not set up for this client. Agree a rate on the client's services first.`,
      );
    }
    if (rate.service.code) {
      throw new Error(`"${rate.service.description}" is charged automatically and cannot be added.`);
    }
    // A deactivated service already on the shipment may stay; it is not
    // offered for anything new.
    if (rate.service.isActive === false && !alreadyAttached.has(serviceId)) {
      throw new Error(
        `"${rate.service.description}" has been deactivated, so it can't be added. Reactivate it under Services first.`,
      );
    }
    resolved.push({ serviceId, clientServiceId: rate.id, quantity });
  }
  return resolved;
};

/**
 * Step 1: open a bulk shipment with the products the office wants sent.
 * The lines are optional so a shell can still be opened and planned later.
 */
const createBulkShipment = async (data, actorUserId) => {
  const { clientId, categoryId } = data;

  if (!clientId) throw new Error('A client is required.');
  if (!categoryId) throw new Error('A category is required.');

  const category = await fbaRepository.getCategoryById(categoryId);
  if (!category) throw new Error('That category does not exist.');

  const client = await clientRepository.getClientByField('id', clientId);
  if (!client) throw new Error('That client does not exist.');

  const lines = normaliseLines(data.lines ?? []);
  await assertProductsBelongTo(clientId, lines);
  const services = await resolveServices(clientId, data.services);

  const shell = {
    ...readDetails(data),
    categoryId,
    clientId,
    status: lines.length > 0 ? 'PREPARING' : 'DRAFT',
    createdByUserId: actorUserId ?? null,
  };

  // Reference is issued inside the transaction and retried on the one unique
  // clash it can hit — two creates picking the same number at once.
  for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt += 1) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const reference = await nextBulkReference(tx);
        const shipment = await fbaRepository.createShipment({ ...shell, reference }, tx);
        if (lines.length === 0 && services.length === 0) return shipment;
        await reserveLines(shipment.id, lines, new Map(), tx);
        for (const service of services) {
          await fbaRepository.createService({ fbaShipmentId: shipment.id, ...service }, tx);
        }
        return await fbaRepository.getShipmentById(shipment.id, tx);
      }, TRANSACTION_OPTIONS);
      await audit(actorUserId, 'FBA_SHIPMENT_CREATED', {
        fbaShipmentId: created.id,
        reference: created.reference,
        clientId,
        lineCount: lines.length,
        units: countUnits(lines),
        services: services.length,
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

/**
 * Works out what moving a shipment to another client would take with it.
 * Products belong to exactly one client, so every product that is not the new
 * client's goes. A service stays only if the new client has a rate for it.
 */
const planClientMove = async (shipment, newClientId) => {
  const items = shipment.items || [];
  const productIds = [...new Set(items.map((item) => item.productId))];
  const owners = new Map(
    (
      await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, clientId: true },
      })
    ).map((p) => [p.id, p.clientId]),
  );
  const removedItems = items.filter((item) => owners.get(item.productId) !== newClientId);

  const keptServices = [];
  const removedServices = [];
  for (const svc of shipment.services || []) {
    const rate = await prisma.clientService.findFirst({
      where: { clientId: newClientId, serviceId: svc.serviceId, service: { code: null } },
    });
    if (rate) {
      keptServices.push({ serviceId: svc.serviceId, clientServiceId: rate.id, quantity: svc.quantity });
    } else {
      removedServices.push(svc);
    }
  }
  return { removedItems, keptServices, removedServices };
};

/**
 * Corrects a bulk shipment's details (admin only), whatever its status. Only
 * the fields sent are changed; an empty string clears an optional one. It
 * touches the record alone — a charge already raised on dispatch, and any
 * stock movement, stay as they were.
 *
 * Moving it to another client resets whatever does not belong to that client:
 * its products (their reserved stock handed back, picks and all) and any
 * service the new client has no rate for. That is refused until the caller
 * sends confirmClientReset, and the refusal lists exactly what would go. A
 * dispatched shipment cannot move at all — its stock has left and its charges
 * sit on the old client's invoice. Nor can one that has started being picked,
 * for anyone: picked goods are off the shelf, and dropping their lines would
 * lose track of them. A wrong client at that point means a new shipment for the
 * right one, while this one keeps its picks on record.
 */
const updateBulkShipment = async (id, data = {}, actorUserId) => {
  const shipment = await requireShipment(id);
  const changes = {};
  let move = null;

  if (data.clientId !== undefined && data.clientId !== shipment.clientId) {
    if (!data.clientId) throw new Error('A client is required.');
    const client = await clientRepository.getClientByField('id', data.clientId);
    if (!client) throw new Error('That client does not exist.');
    if (shipment.status === 'DISPATCHED') {
      throw new Error(
        'A dispatched bulk shipment cannot move to another client: its stock has left and its charges are on the current client’s invoice.',
      );
    }
    const pickedUnits = (shipment.items || []).reduce(
      (sum, item) => sum + Number(item.pickedQuantity || 0),
      0,
    );
    if (pickedUnits > 0) {
      throw new Error(
        `The client cannot be changed once picking has started — ${pickedUnits} unit(s) are already picked. Raise a new bulk shipment for the correct client; this one keeps its picked items on record.`,
      );
    }

    move = await planClientMove(shipment, data.clientId);
    const resets = move.removedItems.length + move.removedServices.length;
    if (resets > 0 && data.confirmClientReset !== true) {
      const err = new Error(
        `Moving this shipment to ${client.companyName} removes ${move.removedItems.length} product line(s) and ${move.removedServices.length} service(s) that do not belong to them. They will have to be added again.`,
      );
      err.code = 'CONFIRM_CLIENT_RESET';
      err.removes = {
        products: move.removedItems.map((item) => ({
          sku: item.product?.skuCode ?? null,
          name: item.product?.productName ?? null,
          quantity: item.quantity,
          pickedQuantity: item.pickedQuantity,
        })),
        services: move.removedServices.map((svc) => ({
          description: svc.service?.description ?? null,
          quantity: Number(svc.quantity),
        })),
      };
      throw err;
    }
    changes.clientId = data.clientId;
  }

  if (data.categoryId !== undefined && data.categoryId !== shipment.categoryId) {
    if (!data.categoryId) throw new Error('A category is required.');
    const category = await fbaRepository.getCategoryById(data.categoryId);
    if (!category) throw new Error('That category does not exist.');
    changes.categoryId = data.categoryId;
  }

  Object.assign(changes, readDetails(data));

  if (Object.keys(changes).length === 0) return shipment;

  const updated = await prisma.$transaction(async (tx) => {
    if (move) {
      // The checks above ran on a read taken before this transaction. Re-made
      // here under the lock, so a pick or plan change that landed since cannot
      // be swept away by the move.
      const fresh = await lockShipment(id, tx);
      if (fresh.status === 'DISPATCHED') {
        throw new Error('This bulk shipment has been dispatched since it was opened; its client cannot change.');
      }
      assertNothingPicked(fresh, 'The client cannot be changed');
      const sameLines =
        (fresh.items || []).length === (shipment.items || []).length &&
        (fresh.items || []).every((item) => (shipment.items || []).some((old) => old.id === item.id));
      if (!sameLines) {
        throw new Error('Its products changed while you were editing it. Reopen it and try again.');
      }
      // Only a PREPARING shipment holds reservations for its lines.
      if (shipment.status === 'PREPARING') {
        for (const item of move.removedItems) {
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
      if (move.removedItems.length > 0) {
        await fbaRepository.deleteItemsByIds(move.removedItems.map((item) => item.id), tx);
      }
      await fbaRepository.deleteServicesByShipment(id, tx);
      for (const service of move.keptServices) {
        await fbaRepository.createService({ fbaShipmentId: id, ...service }, tx);
      }
      // Nothing left to pick: back to DRAFT, as an emptied plan does.
      const itemsLeft = (shipment.items || []).length - move.removedItems.length;
      if (shipment.status === 'PREPARING' && itemsLeft === 0) changes.status = 'DRAFT';
    }
    return await fbaRepository.updateShipment(id, changes, tx);
  }, TRANSACTION_OPTIONS);
  await audit(actorUserId, 'FBA_SHIPMENT_UPDATED', {
    fbaShipmentId: id,
    reference: shipment.reference,
    changes,
    ...(move
      ? {
          fromClientId: shipment.clientId,
          removedProductLines: move.removedItems.length,
          removedServices: move.removedServices.map((svc) => svc.serviceId),
        }
      : {}),
  });
  return updated;
};

/**
 * Changes the plan: the products and quantities a bulk shipment should carry.
 *
 * Replaces the whole line set, so the editor sends the plan as it stands. Every
 * line's hold is handed back first and taken again, so re-planning nets
 * correctly. Picks always survive a change of plan:
 *
 *   - a line kept keeps its picks, even above its new quantity — the extra is
 *     shown as to put back;
 *   - a picked line dropped from the plan stays as a zero-quantity line holding
 *     its picked goods, until they are put back and it disappears;
 *   - a new line starts unpicked.
 *
 * Dispatch waits until every line matches. An empty plan with nothing picked
 * drops the shipment back to DRAFT.
 */
const setBulkItems = async (id, rawLines, actorUserId) => {
  const shipment = await requireShipment(id);
  if (!['DRAFT', 'PREPARING'].includes(shipment.status)) {
    throw new Error(
      `Products can only be changed while a bulk shipment is being prepared — this one is ${shipment.status}.`,
    );
  }

  const lines = normaliseLines(rawLines);
  await assertProductsBelongTo(shipment.clientId, lines);

  const { updated, keptPicked } = await prisma.$transaction(async (tx) => {
    const fresh = await lockShipment(id, tx);
    if (!['DRAFT', 'PREPARING'].includes(fresh.status)) {
      throw new Error(`Products can only be changed while it is being prepared — it is now ${fresh.status}.`);
    }
    const existing = fresh.items || [];

    // Hand back what the current lines hold, remembering picks and put-backs.
    const pickedByKey = new Map();
    const putBackByKey = new Map();
    const firstByKey = new Map();
    for (const item of existing) {
      const key = lineKey(item);
      pickedByKey.set(key, (pickedByKey.get(key) ?? 0) + item.pickedQuantity);
      putBackByKey.set(key, (putBackByKey.get(key) ?? 0) + (item.putBackQuantity ?? 0));
      if (!firstByKey.has(key)) firstByKey.set(key, item);
      await releaseHeld(item, heldFor(item, fresh.status), tx);
    }
    await fbaRepository.deleteItemsByShipment(id, tx);

    await reserveLines(id, lines, pickedByKey, tx, putBackByKey);

    // Picked goods whose line left the plan stay on record, planned at zero.
    const planned = new Set(lines.map(lineKey));
    const kept = [...pickedByKey.entries()]
      .filter(([key, picked]) => picked > 0 && !planned.has(key))
      .map(([key]) => {
        const item = firstByKey.get(key);
        return {
          productId: item.productId,
          sourceLocationId: item.sourceLocationId,
          quantity: 0,
          boxes: null,
          barcode: item.barcode ?? null,
        };
      });
    await reserveLines(id, kept, pickedByKey, tx, putBackByKey);

    const nextStatus = lines.length + kept.length > 0 ? 'PREPARING' : 'DRAFT';
    const updated = await fbaRepository.updateShipment(id, { status: nextStatus }, tx);
    return { updated, keptPicked: kept.length };
  }, TRANSACTION_OPTIONS);

  // After the commit: an audit write runs on its own connection, so inside the
  // transaction it only held it open.
  await audit(actorUserId, 'FBA_SHIPMENT_PLANNED', {
    fbaShipmentId: id,
    lineCount: lines.length,
    units: countUnits(lines),
    droppedLinesAwaitingPutBack: keptPicked,
  });
  return updated;
};

/**
 * Step 2: the floor records what it has picked against the plan.
 *
 * picks is [{ itemId, pickedQuantity }] — absolute counts, not increments, so
 * a retried save cannot double-count. Only the lines sent are touched. Raising
 * a count past the plan is refused: sending more than was asked for is a
 * change to the plan, and that belongs to whoever raised the shipment.
 *
 * Lowering a count is putting goods back on the shelf, and is recorded as such:
 * the line's putBackQuantity rises by the difference, any of its hold beyond
 * the plan is handed back, and the put-back is audited with its bins. A
 * zero-quantity line (dropped from the plan) disappears once nothing on it is
 * picked. On a voided shipment only put-backs are accepted.
 */
const recordPicks = async (id, rawPicks, actorUserId) => {
  if (!Array.isArray(rawPicks) || rawPicks.length === 0) {
    throw new Error('Send at least one picked line.');
  }

  const { updated, putBack } = await prisma.$transaction(async (tx) => {
    const shipment = await lockShipment(id, tx);
    const voided = shipment.status === 'CANCELLED';
    if (shipment.status !== 'PREPARING' && !voided) {
      throw new Error(
        `Only a bulk shipment being prepared can be picked — this one is ${shipment.status}.`,
      );
    }

    const items = new Map((shipment.items || []).map((item) => [item.id, item]));
    const changes = rawPicks.map((pick, i) => {
      const item = items.get(pick.itemId);
      if (!item) throw new Error(`Line ${i + 1}: that line is not on this shipment.`);
      const sku = item.product?.skuCode ?? 'That product';
      const picked = Number(pick.pickedQuantity);
      if (!Number.isInteger(picked) || picked < 0) {
        throw new Error(`${sku}: picked quantity must be a whole number, zero or more.`);
      }
      if (picked > item.pickedQuantity) {
        if (voided) {
          throw new Error(`${sku}: this shipment is voided — picked goods can only be put back.`);
        }
        if (picked > item.quantity) {
          throw new Error(
            `${sku}: ${picked} picked but only ${item.quantity} planned. Change the plan if more should go.`,
          );
        }
      }
      return { item, picked };
    });

    const putBack = [];
    let pickedMore = false;
    let remaining = (shipment.items || []).length;
    for (const { item, picked } of changes) {
      const returned = Math.max(0, item.pickedQuantity - picked);
      if (picked > item.pickedQuantity) pickedMore = true;
      if (returned > 0) putBack.push({ item, units: returned });

      const after = { ...item, pickedQuantity: picked };
      await releaseHeld(item, heldFor(item, shipment.status) - heldFor(after, shipment.status), tx);

      if (item.quantity === 0 && picked === 0) {
        // Dropped from the plan and now all back on the shelf: nothing left to track.
        await fbaRepository.deleteItemsByIds([item.id], tx);
        remaining -= 1;
        continue;
      }
      await fbaRepository.updateItem(
        item.id,
        {
          pickedQuantity: picked,
          ...(returned > 0 ? { putBackQuantity: { increment: returned } } : {}),
        },
        tx,
      );
    }

    const updated = await fbaRepository.updateShipment(
      id,
      {
        ...(pickedMore ? { preparedByUserId: actorUserId ?? null } : {}),
        ...(!voided && remaining === 0 ? { status: 'DRAFT' } : {}),
      },
      tx,
    );
    return { updated, putBack };
  }, TRANSACTION_OPTIONS);

  const lines = updated.items || [];
  await audit(actorUserId, 'FBA_SHIPMENT_PICKED', {
    fbaShipmentId: id,
    picked: pickedUnitsOf(lines),
    planned: countUnits(lines),
  });
  if (putBack.length > 0) {
    await audit(actorUserId, 'FBA_SHIPMENT_PUT_BACK', {
      fbaShipmentId: id,
      reference: updated.reference,
      lines: putBack.map(({ item, units }) => ({
        itemId: item.id,
        productId: item.productId,
        sku: item.product?.skuCode ?? null,
        locationId: item.sourceLocationId,
        units,
      })),
    });
  }
  return updated;
};

/**
 * Replaces the services attached to a bulk shipment. Only before dispatch:
 * once charged, a change here would no longer match the invoice. Open to
 * fba:update, the same as changing its products. Nothing is priced here.
 */
const setBulkServices = async (id, rawServices, actorUserId) => {
  const shipment = await requireShipment(id);
  if (!['DRAFT', 'PREPARING'].includes(shipment.status)) {
    throw new Error(
      `Services can only be changed before a bulk shipment is dispatched — this one is ${shipment.status}.`,
    );
  }
  const services = await resolveServices(
    shipment.clientId,
    rawServices ?? [],
    new Set((shipment.services ?? []).map((svc) => svc.serviceId)),
  );

  const updated = await prisma.$transaction(async (tx) => {
    const fresh = await lockShipment(id, tx);
    if (!['DRAFT', 'PREPARING'].includes(fresh.status)) {
      throw new Error(`Services can only be changed before dispatch — it is now ${fresh.status}.`);
    }
    await fbaRepository.deleteServicesByShipment(id, tx);
    for (const service of services) {
      await fbaRepository.createService({ fbaShipmentId: id, ...service }, tx);
    }
    return await fbaRepository.getShipmentById(id, tx);
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'FBA_SHIPMENT_SERVICES_SET', {
    fbaShipmentId: id,
    services: services.map((svc) => ({ serviceId: svc.serviceId, quantity: svc.quantity })),
  });
  return updated;
};

/**
 * Explains why a shipment's picks do not match its plan, or returns null when
 * they do: what is still to pick, and what is to go back on the shelf.
 */
const pickMismatch = (items) => {
  const toPick = items
    .filter((item) => item.pickedQuantity < item.quantity)
    .map((item) => `${item.product?.skuCode ?? 'a product'} ${item.pickedQuantity}/${item.quantity}`);
  const toPutBack = items
    .filter((item) => item.pickedQuantity > item.quantity)
    .map((item) => ({ item, units: item.pickedQuantity - item.quantity }));
  if (toPick.length === 0 && toPutBack.length === 0) return null;
  const parts = [];
  if (toPick.length) parts.push(`still to pick: ${toPick.join(', ')}`);
  if (toPutBack.length) parts.push(`to put back: ${putBackList(toPutBack)}`);
  return `Picks do not match the plan yet — ${parts.join('; ')}.`;
};

/**
 * Step 3: dispatch. Refused until every line's picks match its plan exactly. Checks the
 * reserved stock out (a real CHECKOUT movement, against this shipment's
 * reference) and bills the client their single Bulk Shipment rate × total
 * units, plus each attached service — all at the client's rates as they stand
 * now, since this is when the charge is raised. A client with no Bulk Shipment
 * rate is not charged for the units; an attached service whose rate has since
 * been removed stops the dispatch rather than going out unbilled.
 */
const dispatchBulk = async (id, actorUserId) => {
  const shipment = await requireShipment(id);
  assertTransition(shipment.status, 'DISPATCHED');

  const items = shipment.items || [];
  if (items.length === 0) {
    throw new Error('A bulk shipment cannot be dispatched with no products added.');
  }

  const mismatch = pickMismatch(items);
  if (mismatch) throw new Error(mismatch);

  const { updated, totalUnits, charged } = await prisma.$transaction(async (tx) => {
    // The checks above were for a quick answer; these, on the locked row, are
    // the ones that count — a pick lowered or a line changed since cannot slip
    // past them.
    const fresh = await lockShipment(id, tx);
    assertTransition(fresh.status, 'DISPATCHED');
    const items = fresh.items || [];
    if (items.length === 0) {
      throw new Error('A bulk shipment cannot be dispatched with no products added.');
    }
    const stillOff = pickMismatch(items);
    if (stillOff) throw new Error(stillOff);

    // Each attached service's rate as it stands today.
    const serviceRates = [];
    const unrated = [];
    for (const attached of fresh.services || []) {
      const rate = await tx.clientService.findFirst({
        where: { clientId: fresh.clientId, serviceId: attached.serviceId },
      });
      if (rate) serviceRates.push({ attached, rate });
      else unrated.push(attached.service?.description ?? 'A service');
    }
    if (unrated.length > 0) {
      throw new Error(
        `${unrated.join(', ')} no longer has a rate for this client. Agree one, or remove it from the shipment, before dispatching.`,
      );
    }

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

    const charges = [];
    if (rate && unitPrice > 0) {
      charges.push({
        clientServiceId: rate.clientService.id,
        quantity: totalUnits,
        unitPrice,
        description: `Bulk shipment ${shipment.reference} — ${totalUnits} unit(s) across ${items.length} product(s)`,
        itemType: 'FBA_CHARGE',
      });
    }
    for (const { attached, rate: serviceRate } of serviceRates) {
      const price = Number(serviceRate.chargedPrice);
      // The record of what it went out at, on the shipment itself.
      await fbaRepository.updateService(
        attached.id,
        { appliedUnitPrice: price, clientServiceId: serviceRate.id },
        tx,
      );
      if (!(price > 0)) continue;
      charges.push({
        clientServiceId: serviceRate.id,
        quantity: Number(attached.quantity),
        unitPrice: price,
        description: `Bulk shipment ${shipment.reference} — ${attached.service?.description ?? 'Service'}`.slice(0, 255),
        itemType: 'AUTOMATED_SERVICE',
      });
    }

    let charged = null;
    if (charges.length > 0) {
      const invoice = await resolveOpenInvoiceFor(shipment.clientId, tx);
      charged = 0;

      for (const charge of charges) {
        const totalPrice = Number((charge.quantity * charge.unitPrice).toFixed(2));
        await invoiceLineItemRepository.createInvoiceLineItem(
          {
            ...charge,
            invoiceId: invoice.id,
            // So deleting the shipment can find and reverse exactly these.
            fbaShipmentId: id,
            totalPrice,
            dateOfService: dispatchedAt,
          },
          tx,
        );
        charged += totalPrice;
      }

      const { _sum } = await tx.invoiceLineItem.aggregate({
        where: { invoiceId: invoice.id },
        _sum: { totalPrice: true },
      });
      await tx.monthlyInvoice.update({
        where: { id: invoice.id },
        data: { totalAmount: _sum.totalPrice ?? 0 },
      });

      charged = Number(charged.toFixed(2));
    }

    return { updated, totalUnits, charged };
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'FBA_SHIPMENT_DISPATCHED', {
    fbaShipmentId: id,
    clientId: shipment.clientId,
    units: totalUnits,
    products: items.length,
    charged,
  });
  return updated;
};

/**
 * Voids a bulk shipment before dispatch. Allowed whatever is picked: the record
 * stays, lines and picks included, so picked goods remain tracked. Everything
 * not picked is handed back to the shelf straight away; picked goods stay held
 * until they are put back on the (put-back-only) Pick screen, after which it
 * can be deleted or moved to another client.
 */
const cancel = async (id, reason, actorUserId) => {
  const shipment = await requireShipment(id);
  assertTransition(shipment.status, 'CANCELLED');

  const updated = await prisma.$transaction(async (tx) => {
    const fresh = await lockShipment(id, tx);
    assertTransition(fresh.status, 'CANCELLED');

    // Only a PREPARING shipment holds stock; DRAFT and legacy RECEIVED hold
    // none. Of what it holds, only the picked goods stay held once voided.
    if (fresh.status === 'PREPARING') {
      for (const item of fresh.items || []) {
        await releaseHeld(item, heldFor(item, 'PREPARING') - heldFor(item, 'CANCELLED'), tx);
      }
    }

    return await fbaRepository.updateShipment(id, { status: 'CANCELLED' }, tx);
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'FBA_SHIPMENT_CANCELLED', {
    fbaShipmentId: id,
    reason: reason ?? null,
    pickedStillToPutBack: pickedUnitsOf(updated.items),
  });
  return updated;
};

// ─── What a delete would refuse on, and undo ───────────────────────────────────

/** The charges a dispatch raised: the Bulk Shipment charge and its services. */
const DISPATCH_CHARGE_TYPES = ['FBA_CHARGE', 'AUTOMATED_SERVICE'];

/**
 * How the old line Return button described its charge. Only MANUAL_CHARGE lines
 * on the shipment starting with this are swept up by undoBulkLineReturns.
 */
const LEGACY_LINE_RETURN_CHARGE_PREFIX = 'Return handling — ';

/**
 * What each line counts as returned beyond its return records: what the line
 * Return button booked before it made records. Only lines with something.
 */
const legacyLineReturnsOn = async (fbaShipmentId, tx) => {
  const client = tx || prisma;
  const [items, records] = await Promise.all([
    client.fbaShipmentItem.findMany({
      where: { fbaShipmentId, returnedQuantity: { gt: 0 } },
      select: { id: true, productId: true, sourceLocationId: true, returnedQuantity: true },
    }),
    client.productReturn.groupBy({
      by: ['fbaShipmentItemId'],
      where: { fbaShipmentId, fbaShipmentItemId: { not: null } },
      _sum: { quantity: true },
    }),
  ]);
  const viaRecords = new Map(records.map((r) => [r.fbaShipmentItemId, r._sum.quantity ?? 0]));
  return items
    .map((item) => ({
      ...item,
      quantity: Math.max(0, item.returnedQuantity - (viaRecords.get(item.id) ?? 0)),
    }))
    .filter((item) => item.quantity > 0);
};

const legacyLineReturnCharges = (fbaShipmentId, tx) =>
  (tx || prisma).invoiceLineItem.findMany({
    where: {
      fbaShipmentId,
      itemType: 'MANUAL_CHARGE',
      description: { startsWith: LEGACY_LINE_RETURN_CHARGE_PREFIX },
    },
    include: { invoice: { select: { status: true } } },
  });

/**
 * What deleting a bulk shipment would refuse on, and what it would undo. See
 * utils/dependents.js for what blocking and removedWith mean.
 *
 * Blocking:
 *  - a dispatch charge on a PAID invoice: reversed with a credit note
 *  - picked units still off the shelf, before dispatch: put back first, as
 *    voiding requires
 *  - returns against it — a return is proof it went out, with charges of its
 *    own. Deleted first, from the Returns screen; and what the line Return
 *    button booked before it made records, undone from the shipment.
 */
const getBulkShipmentDependents = async (id) => {
  const shipment = await requireShipment(id);
  const dispatched = shipment.status === 'DISPATCHED';
  const items = shipment.items || [];

  const [returns, legacy, chargeLines, services] = await Promise.all([
    prisma.productReturn.count({ where: { fbaShipmentId: id } }),
    legacyLineReturnsOn(id),
    dispatched
      ? prisma.invoiceLineItem.findMany({
          where: { fbaShipmentId: id, itemType: { in: DISPATCH_CHARGE_TYPES } },
          select: { invoice: { select: { status: true } } },
        })
      : [],
    prisma.fbaShipmentService.count({ where: { fbaShipmentId: id } }),
  ]);
  const paid = paidAmong(chargeLines).length;
  const picked = dispatched ? 0 : pickedUnitsOf(items);
  const unitsBack = dispatched
    ? items.reduce((sum, item) => sum + Math.max(0, item.quantity - (item.returnedQuantity ?? 0)), 0)
    : shipment.status === 'PREPARING'
      ? countUnits(items)
      : 0;

  return {
    shipment,
    report: buildReport({
      blocking: [
        {
          key: 'paidInvoice',
          label: 'Charges on a paid invoice',
          count: paid,
          where: '/invoices',
          note: 'Money has changed hands. Raise a credit note on that invoice instead.',
        },
        {
          key: 'picked',
          label: 'Picked units off the shelf',
          count: picked,
          note: 'Put them back first, on the Pick screen.',
        },
        {
          key: 'returns',
          label: 'Returns recorded against it',
          count: returns,
          where: '/returns',
          note: 'Delete those returns first.',
        },
        {
          key: 'lineReturns',
          label: 'Units returned from its lines',
          count: legacy.reduce((sum, line) => sum + line.quantity, 0),
          note: "Returned with the line return button before it recorded returns. Undo them from the bulk shipment's details.",
        },
      ],
      removedWith: [
        { key: 'items', label: 'Bulk shipment lines', count: items.length },
        {
          key: 'units',
          label: dispatched ? 'Units put back on their shelves' : 'Reserved units released',
          count: unitsBack,
        },
        {
          key: 'charges',
          label: 'Charges taken off unpaid invoices',
          count: chargeLines.length - paid,
          where: '/invoices',
        },
        { key: 'services', label: 'Billable services attached', count: services },
      ],
    }),
  };
};

/**
 * What undoing a bulk shipment's old line returns would refuse on and undo —
 * the bulk counterpart of shipment.logic getLineReturnDependents, for returns
 * the line Return button booked before it made records.
 */
const getBulkLineReturnDependents = async (id) => {
  const shipment = await requireShipment(id);
  const [lines, charges] = await Promise.all([legacyLineReturnsOn(id), legacyLineReturnCharges(id)]);

  // Two lines can share a product and a bin; the shelf has to cover both.
  const wanted = new Map();
  for (const line of lines) {
    const key = `${line.productId}|${line.sourceLocationId}`;
    wanted.set(key, (wanted.get(key) ?? 0) + line.quantity);
  }
  let shortfall = 0;
  for (const [key, quantity] of wanted) {
    const [productId, locationId] = key.split('|');
    shortfall += Math.max(0, quantity - (await freeUnitsIn(productId, locationId)));
  }
  const paid = paidAmong(charges).length;

  return {
    shipment,
    lines,
    report: buildReport({
      blocking: [
        {
          key: 'paidInvoice',
          label: 'Return charges on a paid invoice',
          count: paid,
          where: '/invoices',
          note: 'Money has changed hands. Raise a credit note on that invoice instead.',
        },
        {
          key: 'stockGone',
          label: 'Returned units no longer free on the shelf',
          count: shortfall,
          where: '/inventory',
          note: 'They have been reserved, picked or moved since they came back.',
        },
      ],
      removedWith: [
        {
          key: 'units',
          label: 'Units taken back off their shelves',
          count: lines.reduce((sum, line) => sum + line.quantity, 0),
        },
        {
          key: 'charges',
          label: 'Return charges taken off unpaid invoices',
          count: charges.length - paid,
          where: '/invoices',
        },
      ],
    }),
  };
};

/**
 * Undoes every return the line Return button booked on a bulk shipment before
 * it made records: the units come back off their bins, each line counts them
 * as out again, and their charges come off unpaid invoices. Return records are
 * untouched — they are deleted from the Returns screen.
 */
const undoBulkLineReturns = async (id, actorUserId) => {
  if (!actorUserId) throw new Error('An authenticated user is required to undo returns.');
  const { shipment, lines, report } = await getBulkLineReturnDependents(id);
  if (lines.length === 0) {
    throw new Error(`Nothing was returned with the old line return button on ${shipment.reference}.`);
  }
  assertDeletable(`Bulk shipment ${shipment.reference}`, report);

  const undone = await prisma.$transaction(async (tx) => {
    await lockShipment(id, tx);
    const [fresh, charges] = await Promise.all([
      legacyLineReturnsOn(id, tx),
      legacyLineReturnCharges(id, tx),
    ]);
    if (paidAmong(charges).length > 0) {
      throw new Error(
        `A return charge for ${shipment.reference} is on a paid invoice — raise a credit note instead.`,
      );
    }

    for (const line of fresh) {
      const { count } = await tx.fbaShipmentItem.updateMany({
        where: { id: line.id, returnedQuantity: { gte: line.quantity } },
        data: { returnedQuantity: { decrement: line.quantity } },
      });
      if (count === 0) {
        throw new Error("A line's returns changed while this was being undone. Try again.");
      }
      await takeOffShelf(
        {
          productId: line.productId,
          locationId: line.sourceLocationId,
          quantity: line.quantity,
          reference: shipment.reference,
          notes: `Line return on ${shipment.reference} undone`,
          actorUserId,
        },
        tx,
      );
    }

    await removeChargeLines(charges, tx);
    return {
      lines: fresh.map((line) => ({ fbaShipmentItemId: line.id, quantity: line.quantity })),
      chargesRemoved: charges.length,
    };
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'FBA_SHIPMENT_LINE_RETURNS_UNDONE', {
    fbaShipmentId: id,
    reference: shipment.reference,
    clientId: shipment.clientId,
    ...undone,
  });
  return { id, ...undone };
};

/**
 * Hard-deletes a bulk shipment (admin only), whatever its status. Item rows
 * cascade with it.
 *
 *   PREPARING  — its reservation is handed back. Refused while anything on it
 *                is picked, as voiding is.
 *   DISPATCHED — the goods left the shelf, so what is still out on each line
 *                (less anything already returned) goes back to its source bin
 *                as a RETURN movement carrying the shipment reference, so it
 *                reads as a pair with the CHECKOUT. The charges its dispatch
 *                raised — the Bulk Shipment charge and its services — come off
 *                the invoice, which is recalculated. Refused outright once that
 *                invoice is PAID: money that has changed hands is put right
 *                with a credit note, not by deleting what it was for.
 *
 * Returns against it refuse it too (getBulkShipmentDependents): they carry
 * charges of their own, and are deleted first, from the Returns screen.
 */
const remove = async (id, actorUserId) => {
  const { shipment, report } = await getBulkShipmentDependents(id);
  assertDeletable(`Bulk shipment ${shipment.reference}`, report);

  const reversal = await prisma.$transaction(async (tx) => {
    const fresh = await lockShipment(id, tx);
    if (fresh.status !== shipment.status) {
      throw new Error(`It changed to ${fresh.status} while you were looking at it. Reopen it and try again.`);
    }
    if (fresh.status !== 'DISPATCHED') assertNothingPicked(fresh, 'It cannot be deleted');
    const restored = [];
    let chargesRemoved = 0;

    if (shipment.status === 'DISPATCHED') {
      // The charges first, so a paid invoice refuses before any stock moves.
      const chargeLines = await tx.invoiceLineItem.findMany({
        where: { fbaShipmentId: id, itemType: { in: ['FBA_CHARGE', 'AUTOMATED_SERVICE'] } },
        include: { invoice: { select: { id: true, status: true } } },
      });
      if (chargeLines.some((line) => line.invoice?.status === 'PAID')) {
        throw new Error(
          "This bulk shipment's invoice has already been paid, so it cannot be deleted — raise a credit note against that invoice instead.",
        );
      }

      const items = await fbaRepository.getItemsByShipment(id, tx);
      for (const item of items) {
        const outstanding = item.quantity - (item.returnedQuantity ?? 0);
        if (outstanding <= 0) continue;
        await inventoryLedgerLogic.createInventoryLedger(
          {
            productId: item.productId,
            userId: actorUserId,
            movementType: 'RETURN',
            quantity: outstanding,
            toLocationId: item.sourceLocationId,
            referenceId: shipment.reference,
            notes: `Reversed on deletion of bulk shipment ${shipment.reference}`,
          },
          { tx },
        );
        restored.push({ productId: item.productId, quantity: outstanding });
      }

      const invoiceIds = new Set(chargeLines.map((line) => line.invoiceId));
      for (const line of chargeLines) {
        await invoiceLineItemRepository.deleteInvoiceLineItem(line.id, tx);
        chargesRemoved += Number(line.totalPrice);
      }
      for (const invoiceId of invoiceIds) {
        await monthlyInvoiceRepository.recalculateInvoiceTotal(invoiceId, tx);
      }
      chargesRemoved = Number(chargesRemoved.toFixed(2));
    }

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

    await fbaRepository.deleteShipment(id, tx);
    return { restored, chargesRemoved };
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'FBA_SHIPMENT_DELETED', {
    fbaShipmentId: id,
    reference: shipment.reference,
    clientId: shipment.clientId,
    status: shipment.status,
    ...(shipment.status === 'DISPATCHED' ? reversal : {}),
  });
  return { id, ...reversal };
};

/**
 * Records, corrects or clears the tracking number — the one detail that
 * legitimately arrives at dispatch or after it, since that is when a courier
 * issues it. Separate from updateBulkShipment (admin only) so whoever hands the
 * goods over can record it. Refused only once voided: nothing went out.
 */
const setBulkTracking = async (id, rawTrackingId, actorUserId) => {
  const shipment = await requireShipment(id);
  if (shipment.status === 'CANCELLED') {
    throw new Error('A voided bulk shipment has nothing to track.');
  }
  const trackingId = cleanText(rawTrackingId, 64);
  if (trackingId === (shipment.trackingId ?? null)) return shipment;

  const updated = await fbaRepository.updateShipment(id, { trackingId });
  await audit(actorUserId, trackingId ? 'FBA_SHIPMENT_TRACKING_SET' : 'FBA_SHIPMENT_TRACKING_CLEARED', {
    fbaShipmentId: id,
    from: shipment.trackingId ?? null,
    to: trackingId,
    status: shipment.status,
  });
  return updated;
};

// Returning a dispatched line lives in product_return.logic (recordBulkLineReturn):
// the line's Return button books a return record, like an outbound line's, so
// every return has a RET number and is deleted from the Returns screen.

/**
 * The delivery note, rendered from the shipment as it stands. Not stored: it
 * is a packing document, and a corrected address should print corrected.
 */
const getDeliveryNote = async (id) => {
  const shipment = await requireShipment(id);
  return {
    shipment,
    buffer: renderDeliveryNotePdf(shipment),
    filename: `Delivery_Note_${shipment.reference}.pdf`,
  };
};

/** The services a client has agreed rates for that may be attached by hand. */
const getAttachableServices = async (clientId) =>
  await prisma.clientService.findMany({
    where: { clientId, service: { code: null } },
    include: { service: { select: { id: true, description: true, unit: true, isActive: true } } },
    orderBy: { service: { description: 'asc' } },
  });

const getAllShipments = async () => await fbaRepository.getAllShipments();
const getShipmentsByClientId = async (clientId) =>
  await fbaRepository.getShipmentsByClientId(clientId);
const getShipmentById = async (id) => await requireShipment(id);

module.exports = {
  addCategory,
  getAllCategories,
  updateCategory,
  deleteCategory,
  getCategoryDependents,
  createBulkShipment,
  updateBulkShipment,
  setBulkItems,
  recordPicks,
  setBulkServices,
  dispatchBulk,
  cancel,
  remove,
  getBulkShipmentDependents,
  getBulkLineReturnDependents,
  undoBulkLineReturns,
  setBulkTracking,
  getAllShipments,
  getShipmentsByClientId,
  getShipmentById,
  getDeliveryNote,
  getAttachableServices,
  FBA_TRANSITIONS,
  assertTransition,
};
