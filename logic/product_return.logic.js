'use strict';

/**
 * Return handling — goods coming back, booked at the returns bench.
 *
 *   1. record  — scan the tracking number on the parcel, scan the product. The
 *                product decides whose goods these are (a barcode is globally
 *                unique); the tracking number, when it matches a dispatched
 *                shipment, must agree and links the return to that line. The
 *                return gets a RET-YYYY-NNNNNN number and the client is charged
 *                their ITEM_RETURN rate.
 *   2. resolve — someone decides what happens to the goods:
 *                  dispose  — nothing further is charged; the return is closed.
 *                  restock  — the goods go back on a shelf (a RETURN movement,
 *                             so the count is right the moment it commits) and
 *                             the client is charged their RETURN_RESTOCK rate.
 *
 * Nothing about the charge is typed in. The reference, the client, the rate and
 * the invoice it lands on are all worked out here, for the same reason dispatch
 * works them out: a number keyed at a bench is a number keyed wrong eventually.
 *
 * Status is moved only by the two actions below, and only out of RECORDED — the
 * same state-machine rule Shipment and FbaShipment follow.
 */

const { prisma } = require('../lib/prisma');
const productReturnRepository = require('../repositories/product_return.repository');
const invoiceLineItemRepository = require('../repositories/invoice_line_item.repository');
const monthlyInvoiceRepository = require('../repositories/monthly_invoice.repository');
const productLogic = require('./product.logic');
const inventoryLedgerLogic = require('./inventory_ledger.logic');
const auditLogLogic = require('./audit_log.logic');
const { normaliseTrackingId } = require('./shipment.logic');
const { parseUuid } = require('../utils/queryFilters');
const { buildReport, assertDeletable } = require('../utils/dependents');
const { freeUnitsIn, takeOffShelf, paidAmong, removeChargeLines } = require('./reversal');
const {
  getReturnRateForClient,
  getRestockRateForClient,
  resolveOpenInvoiceFor,
} = require('./billing_services');

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

const RETURN_STATUSES = ['RECORDED', 'DISPOSED', 'RESTOCKED'];

/** A parcel of returns is a handful of units, not a pallet. Guards a mis-scan into the quantity box. */
const MAX_QUANTITY = 10_000;

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

// ─── The return reference ─────────────────────────────────────────────────────
// RET-<year>-<sequence>, generated the same way as Shipment.reference.

const REFERENCE_PREFIX = 'RET';
const REFERENCE_DIGITS = 6;
const REFERENCE_ATTEMPTS = 5;
const REFERENCE_SCAN = 10;

const referenceSeriesFor = (date) => `${REFERENCE_PREFIX}-${date.getUTCFullYear()}-`;

const nextReturnReference = async (tx) => {
  const series = referenceSeriesFor(new Date());
  const recent = await productReturnRepository.getLatestReferencesInSeries(
    series,
    REFERENCE_SCAN,
    tx,
  );

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

// ─── Matching a parcel to what went out ────────────────────────────────────────

const outstandingOn = (item) => item.quantity - (item.returnedQuantity ?? 0);

/**
 * Refuses a parcel whose tracking number and product name different clients.
 *
 * Only when the tracking number is unambiguous — every shipment it matches
 * belongs to one client. Then a product belonging to someone else means the
 * wrong parcel or the wrong product was scanned, and booking it would bill a
 * client for goods that are not theirs. When the number matches shipments for
 * several clients it identifies nobody, and the product decides alone.
 */
const assertTrackingAgrees = (candidates, product, trackingNumber) => {
  if (candidates.length === 0) return;
  const clientIds = new Set(candidates.map((s) => s.clientId));
  if (clientIds.size !== 1 || clientIds.has(product.clientId)) return;

  const shipment = candidates[0];
  throw withStatus(
    `${product.skuCode} belongs to ${product.client?.companyName ?? 'another client'}, but tracking ` +
      `${trackingNumber} is on shipment ${shipment.reference} for ` +
      `${shipment.client?.companyName ?? 'a different client'}. Check the parcel and the product.`,
    409,
  );
};

/**
 * The shipment, and the line on it, this return comes back against.
 *
 * The most recent matching shipment of the product's own client. On it, the
 * line carrying this product with something still out; failing that, any line
 * carrying it (so the caller can say it has all come back already). A shipment
 * that matches but never carried this product is still linked — the parcel is
 * evidently that shipment's — just without a line.
 */
const resolveLink = (candidates, product) => {
  const own = candidates.filter((s) => s.clientId === product.clientId);
  if (own.length === 0) return { shipment: null, item: null };

  for (const shipment of own) {
    const item = shipment.shipmentItems.find(
      (i) => i.productId === product.id && outstandingOn(i) > 0,
    );
    if (item) return { shipment, item };
  }
  for (const shipment of own) {
    const item = shipment.shipmentItems.find((i) => i.productId === product.id);
    if (item) return { shipment, item };
  }
  return { shipment: own[0], item: null };
};

/**
 * The shipment line an operator picked for a parcel whose label matched none,
 * checked inside the caller's transaction: it has to be a dispatched line
 * carrying this very product, on a shipment of the product's own client.
 * Shaped like resolveLink's result.
 */
const resolveChosenLine = async (shipmentItemId, product, tx) => {
  const item = await tx.shipmentItem.findUnique({
    where: { id: shipmentItemId },
    select: {
      id: true,
      productId: true,
      quantity: true,
      returnedQuantity: true,
      sourceLocationId: true,
      shipment: { select: { id: true, reference: true, clientId: true, status: true } },
    },
  });
  if (!item) throw withStatus('That shipment line does not exist.', 404);
  if (item.shipment.status !== 'DISPATCHED') {
    throw new Error(`Shipment ${item.shipment.reference} has not been dispatched, so nothing on it can come back.`);
  }
  if (item.productId !== product.id || item.shipment.clientId !== product.clientId) {
    throw withStatus(
      `${product.skuCode} is not on shipment ${item.shipment.reference}. Choose a shipment that carried it.`,
      409,
    );
  }
  return { shipment: item.shipment, item };
};

// ─── Charging ─────────────────────────────────────────────────────────────────

/**
 * Raises one charge for a return onto the client's open invoice.
 *
 * Returns null — and raises nothing — when the client has no agreed rate or it
 * is zero. That is an arrangement, not an error: the goods are handled either
 * way, and an invoice is not opened just to hold no lines.
 */
const raiseCharge = async ({
  productReturn,
  rate,
  description,
  // A charge the bench raises on its own. The line Return button passes
  // MANUAL_CHARGE: there an admin chose to charge.
  itemType = 'AUTOMATED_SERVICE',
  tx,
}) => {
  const unitPrice = rate ? Number(rate.unitPrice) : 0;
  if (!rate || !(unitPrice > 0)) return null;

  const invoice = await resolveOpenInvoiceFor(productReturn.clientId, tx);
  const totalPrice = Number((productReturn.quantity * unitPrice).toFixed(2));

  await invoiceLineItemRepository.createInvoiceLineItem(
    {
      invoiceId: invoice.id,
      clientServiceId: rate.clientService.id,
      returnId: productReturn.id,
      quantity: productReturn.quantity,
      unitPrice,
      totalPrice,
      description,
      dateOfService: new Date(),
      itemType,
    },
    tx,
  );

  // Derived from the lines, never accumulated. Also re-applies tax if the
  // invoice carries it.
  await monthlyInvoiceRepository.recalculateInvoiceTotal(invoice.id, tx);

  return { amount: totalPrice, unitPrice, invoiceId: invoice.id };
};

/** What a client's rate card says a return will cost, per unit. Null = no agreed rate. */
const ratesFor = async (clientId) => {
  const [handling, restock] = await Promise.all([
    getReturnRateForClient(clientId),
    getRestockRateForClient(clientId),
  ]);
  return {
    returnHandling: handling ? Number(handling.unitPrice) : null,
    restock: restock ? Number(restock.unitPrice) : null,
  };
};

/**
 * The bin a restock should start on: where the goods were picked from when the
 * return matched a shipment line, otherwise the bin already holding the most of
 * this product. Null when it is on no shelf yet — the operator has to choose.
 */
const suggestLocation = async (productReturn) => {
  if (productReturn.shipmentItemId) {
    const item = await prisma.shipmentItem.findUnique({
      where: { id: productReturn.shipmentItemId },
      select: { sourceLocationId: true },
    });
    if (item) return item.sourceLocationId;
  }
  const top = await prisma.stockLevel.findFirst({
    where: { productId: productReturn.productId },
    orderBy: [{ currentQuantity: 'desc' }, { id: 'asc' }],
    select: { locationId: true },
  });
  return top?.locationId ?? null;
};

/**
 * What the disposition step needs to show, on a return still waiting for one:
 * what restocking would cost and where it would go. Added on the single-return
 * read rather than the list, which would otherwise pay two lookups per row.
 */
const withDispositionHints = async (productReturn) => {
  if (!productReturn || productReturn.status !== 'RECORDED') return productReturn;
  const [rates, suggestedLocationId] = await Promise.all([
    ratesFor(productReturn.clientId),
    suggestLocation(productReturn),
  ]);
  return { ...productReturn, rates, suggestedLocationId };
};

// ─── Identify: what the bench sees before it commits ──────────────────────────

/**
 * Works out what a scanned parcel is, without writing anything.
 *
 * Called as each code is scanned — first the tracking number alone, then with
 * the product code — so the operator sees the client, the shipment it came back
 * from and what it will cost before pressing Record. Recording re-derives all
 * of it rather than trusting what this returned.
 */
const identify = async ({ tracking, code } = {}) => {
  const trackingNumber = tracking ? normaliseTrackingId(String(tracking)) : null;

  const candidates = trackingNumber
    ? await productReturnRepository.findDispatchedShipmentsByTracking(trackingNumber)
    : [];
  const clientIds = new Set(candidates.map((s) => s.clientId));
  const shipment = clientIds.size === 1 ? candidates[0] : null;

  let products = [];
  let matchedOn = null;
  const trimmedCode = String(code ?? '').trim();

  if (trimmedCode) {
    const lookup = await productLogic.lookupByBarcodeOrSku(trimmedCode);
    matchedOn = lookup.matchedOn;
    let matches = lookup.matches;

    // A SKU shared by two clients is narrowed by the parcel, when the parcel
    // names one. A product that is nobody the parcel could be is refused.
    if (shipment && matches.length > 0) {
      const same = matches.filter((p) => p.clientId === shipment.clientId);
      if (same.length === 0) assertTrackingAgrees(candidates, matches[0], trackingNumber);
      matches = same;
    }

    products = await Promise.all(
      matches.map(async (p) => {
        const link = resolveLink(candidates, p);
        return {
          id: p.id,
          skuCode: p.skuCode,
          productName: p.productName,
          barcode: p.barcode,
          isDeactivated: p.isDeactivated,
          clientId: p.clientId,
          client: p.client,
          stockLevels: p.stockLevels,
          rates: await ratesFor(p.clientId),
          // Where a restock would start: the bin it was picked from when the
          // parcel matched a line, else the bin holding the most of it. The
          // bench decides before anything is written, so it is needed now.
          suggestedLocationId:
            link.item?.sourceLocationId ??
            [...(p.stockLevels ?? [])].sort(
              (x, y) => (y.currentQuantity ?? 0) - (x.currentQuantity ?? 0),
            )[0]?.locationId ??
            null,
          shipmentLine: link.item
            ? {
                shipmentId: link.shipment.id,
                reference: link.shipment.reference,
                shipmentItemId: link.item.id,
                quantity: link.item.quantity,
                outstanding: outstandingOn(link.item),
                sourceLocationId: link.item.sourceLocationId,
              }
            : null,
        };
      }),
    );
  }

  return {
    trackingNumber,
    shipment: shipment
      ? {
          id: shipment.id,
          reference: shipment.reference,
          client: shipment.client,
          dispatchedAt: shipment.createdAt,
        }
      : null,
    // The number matched shipments for more than one client, so it cannot say
    // whose parcel this is. The product will.
    trackingAmbiguous: clientIds.size > 1,
    products,
    matchedOn,
  };
};

// ─── Linking by hand ──────────────────────────────────────────────────────────

/** How many lines the link picker is offered at once. */
const LINE_CHOICES = 20;

/**
 * The dispatched shipment lines a parcel of this product could have come back
 * from, for when its label matched none: lines carrying the product with
 * something still out, most recent first, narrowed by a shipment reference
 * fragment when one is typed. Writes nothing; recording checks the choice again.
 */
const findLinesForProduct = async ({ productId: rawProductId, q } = {}) => {
  const productId = parseUuid(rawProductId, 'Product');
  if (!productId) throw new Error('Scan the returned product first.');
  const search = String(q ?? '').trim();

  const lines = await productReturnRepository.findDispatchedLinesForProduct(productId, {
    q: search || undefined,
  });
  return lines
    .filter((line) => outstandingOn(line) > 0)
    .slice(0, LINE_CHOICES)
    .map((line) => ({
      shipmentItemId: line.id,
      shipmentId: line.shipment.id,
      reference: line.shipment.reference,
      dispatchedAt: line.shipment.createdAt,
      trackingId: line.trackingId ?? line.shipment.trackingId ?? null,
      quantity: line.quantity,
      outstanding: outstandingOn(line),
      sourceLocationId: line.sourceLocationId,
    }));
};

// ─── Record ───────────────────────────────────────────────────────────────────

const parseQuantity = (raw) => {
  const amount = raw === undefined || raw === null || raw === '' ? 1 : Number(raw);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Quantity must be a whole number above zero.');
  }
  if (amount > MAX_QUANTITY) {
    throw new Error(`Quantity is too large — ${MAX_QUANTITY} maximum for one return.`);
  }
  return amount;
};

const requireReturn = async (rawId) => {
  const id = parseUuid(rawId, 'Return');
  if (!id) throw withStatus('Return not found.', 404);
  const found = await productReturnRepository.getReturnById(id);
  if (!found) throw withStatus('Return not found.', 404);
  return found;
};

const alreadyResolved = (productReturn) =>
  withStatus(
    `Return ${productReturn.reference} has already been ${productReturn.status === 'DISPOSED' ? 'disposed of' : 'restocked'}.`,
    409,
  );

// ─── Dispositions ─────────────────────────────────────────────────────────────

const DISPOSITIONS = ['dispose', 'restock'];

/**
 * Checks a disposition before any transaction opens, so a missing or unknown
 * location reads as a sentence rather than a foreign-key error half way through.
 */
const parseDisposition = async (raw) => {
  const type = raw?.type;
  if (!DISPOSITIONS.includes(type)) {
    throw new Error('Choose what happens to the goods: dispose off, or inspect & restock.');
  }
  const notes = raw.notes ? String(raw.notes).trim() || null : null;
  if (type === 'dispose') return { type, notes, locationId: null };

  const locationId = parseUuid(raw.locationId, 'Location');
  if (!locationId) {
    throw new Error('Choose the location the goods are going back into.');
  }
  const location = await prisma.warehouseLocation.findUnique({ where: { id: locationId } });
  if (!location) throw withStatus('That location does not exist.', 404);
  return { type, notes, locationId };
};

/**
 * Moves a RECORDED return to its final state, inside the caller's transaction.
 *
 * Dispose: the status, nothing more — no charge, no stock. Restock: the status,
 * a RETURN stock movement into the chosen bin (not a CHECKIN, so goods-in
 * figures are not inflated), and the client's restock charge. All or nothing:
 * a return marked restocked whose units never reached the count, or that was
 * never billed, is the disagreement this exists to prevent.
 *
 * Shared by recording-with-a-decision and by deciding later from the list, so
 * the two paths cannot drift apart. Returns the restock charge, or null.
 */
const applyDisposition = async (productReturn, disposition, actorUserId, tx) => {
  const restock = disposition.type === 'restock';

  const moved = await productReturnRepository.resolveIfOpen(
    productReturn.id,
    {
      status: restock ? 'RESTOCKED' : 'DISPOSED',
      restockLocationId: restock ? disposition.locationId : null,
      resolvedAt: new Date(),
      resolvedByUserId: actorUserId,
      dispositionNotes: disposition.notes,
    },
    tx,
  );
  if (moved === 0) {
    throw alreadyResolved(await productReturnRepository.getReturnById(productReturn.id, tx));
  }
  if (!restock) return null;

  // The ledger applies the stock change itself — adding it here as well would
  // credit the shelf twice.
  await inventoryLedgerLogic.createInventoryLedger(
    {
      productId: productReturn.productId,
      userId: actorUserId,
      movementType: 'RETURN',
      quantity: productReturn.quantity,
      toLocationId: disposition.locationId,
      referenceId: productReturn.reference,
      notes: disposition.notes || `Inspected and restocked from return ${productReturn.reference}`,
    },
    { tx },
  );

  return await raiseCharge({
    productReturn,
    rate: await getRestockRateForClient(productReturn.clientId, tx),
    description: `Return ${productReturn.reference} — ${productReturn.quantity} × ${productReturn.product?.skuCode ?? 'item'} inspected & restocked`,
    tx,
  });
};

const auditDisposition = (actorUserId, productReturn, disposition, charge) =>
  audit(actorUserId, disposition.type === 'restock' ? 'RETURN_RESTOCKED' : 'RETURN_DISPOSED', {
    returnId: productReturn.id,
    reference: productReturn.reference,
    clientId: productReturn.clientId,
    productId: productReturn.productId,
    quantity: productReturn.quantity,
    toLocationId: disposition.locationId,
    charged: charge?.amount ?? null,
  });

/** Charges as one figure for the response; null when none was raised. */
const sumCharges = (...charges) => {
  const raised = charges.filter(Boolean);
  if (raised.length === 0) return null;
  return Number(raised.reduce((sum, c) => sum + c.amount, 0).toFixed(2));
};

/**
 * Books a returned parcel in: issues the number and raises the handling charge.
 *
 * With a `disposition`, the decision is made in the same transaction — the
 * bench flow, where nothing is written until the operator has chosen dispose
 * or restock, so abandoning the dialog half way leaves nothing behind. Without
 * one the return waits as RECORDED, for someone who may record but not decide.
 *
 * `shipmentItemId` links the return to a shipment line the operator chose,
 * for a parcel whose label matched none — a customer's own label, a
 * marketplace return label. Without it the tracking number decides the link,
 * and when that finds no line the return stands unlinked.
 *
 * @param {{ trackingNumber: string, productId: string, quantity?: number, notes?: string,
 *           shipmentItemId?: string,
 *           disposition?: { type: 'dispose'|'restock', locationId?: string, notes?: string } }} payload
 * @param {string} actorUserId whoever is signed in. Never taken from the body.
 */
const recordReturn = async (payload, actorUserId) => {
  if (!actorUserId) {
    throw new Error('An authenticated user is required to record a return.');
  }

  const {
    trackingNumber: rawTracking,
    productId: rawProductId,
    quantity,
    notes,
    shipmentItemId: rawShipmentItemId,
    disposition: rawDisposition,
  } = payload || {};

  const trackingNumber =
    typeof rawTracking === 'string' ? normaliseTrackingId(rawTracking) : null;
  if (!trackingNumber) {
    throw new Error('Scan the tracking number on the returned parcel first.');
  }
  // A malformed id is refused as a sentence here rather than surfacing as
  // Prisma's column error.
  const productId = parseUuid(rawProductId, 'Product');
  if (!productId) {
    throw new Error('Scan the returned product.');
  }
  const amount = parseQuantity(quantity);
  const disposition = rawDisposition ? await parseDisposition(rawDisposition) : null;
  const chosenItemId = rawShipmentItemId ? parseUuid(rawShipmentItemId, 'Shipment line') : null;
  if (rawShipmentItemId && !chosenItemId) {
    throw withStatus('That shipment line does not exist.', 404);
  }

  // Validated before the transaction opens, as receiving does.
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { client: { select: { id: true, companyName: true } } },
  });
  if (!product) {
    throw withStatus('That product does not exist.', 404);
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      const { created, handling, restock, link } = await prisma.$transaction(async (tx) => {
        // Re-matched inside the transaction, so the line and its count are
        // committed state rather than what identify saw a minute ago.
        const candidates = await productReturnRepository.findDispatchedShipmentsByTracking(
          trackingNumber,
          tx,
        );
        assertTrackingAgrees(candidates, product, trackingNumber);
        const matched = resolveLink(candidates, product);
        let link = matched;
        if (chosenItemId) {
          // The label already names a line: a different choice is a stale
          // screen or a mistake, and the label is the better evidence.
          if (matched.item && matched.item.id !== chosenItemId) {
            throw withStatus(
              `Tracking ${trackingNumber} already links this parcel to shipment ${matched.shipment.reference}.`,
              409,
            );
          }
          link = await resolveChosenLine(chosenItemId, product, tx);
        }

        if (link.item) {
          const moved = await productReturnRepository.addReturnedQuantity(
            link.item.id,
            amount,
            tx,
          );
          if (moved === 0) {
            const outstanding = outstandingOn(link.item);
            throw withStatus(
              outstanding > 0
                ? `Only ${outstanding} of ${product.skuCode} on shipment ${link.shipment.reference} is still out — ` +
                    `${link.item.returnedQuantity} of ${link.item.quantity} has already come back.`
                : `All ${link.item.quantity} of ${product.skuCode} on shipment ${link.shipment.reference} ` +
                    'have already come back.',
              409,
            );
          }
        }

        const reference = await nextReturnReference(tx);
        const created = await productReturnRepository.createReturn(
          {
            reference,
            trackingNumber,
            clientId: product.clientId,
            productId: product.id,
            quantity: amount,
            status: 'RECORDED',
            shipmentId: link.shipment?.id ?? null,
            shipmentItemId: link.item?.id ?? null,
            notes: notes ? String(notes).trim() || null : null,
            recordedByUserId: actorUserId,
          },
          tx,
        );

        const handling = await raiseCharge({
          productReturn: created,
          rate: await getReturnRateForClient(product.clientId, tx),
          description: `Return ${reference} — ${amount} × ${product.skuCode} received (tracking ${trackingNumber})`,
          tx,
        });

        const restock = disposition
          ? await applyDisposition(created, disposition, actorUserId, tx)
          : null;

        return { created, handling, restock, link };
      }, TRANSACTION_OPTIONS);

      await audit(actorUserId, 'RETURN_RECORDED', {
        returnId: created.id,
        reference: created.reference,
        trackingNumber,
        clientId: product.clientId,
        productId: product.id,
        quantity: amount,
        shipmentId: link.shipment?.id ?? null,
        shipmentItemId: link.item?.id ?? null,
        charged: handling?.amount ?? null,
      });
      if (disposition) await auditDisposition(actorUserId, created, disposition, restock);

      // Re-read so the charge lines just raised come back with it — and, when
      // no decision was made, what the disposition step will need later.
      const saved = await withDispositionHints(
        await productReturnRepository.getReturnById(created.id),
      );
      return { ...saved, charged: sumCharges(handling, restock) };
    } catch (error) {
      if (attempt >= REFERENCE_ATTEMPTS || !isReferenceClash(error)) throw error;
    }
  }
};

// ─── Record from a shipment line ──────────────────────────────────────────────

/**
 * Books a return from a dispatched line — the Return button on an outbound
 * shipment's line, or on a bulk shipment's.
 *
 * The same record the Returns screen makes, so every return has a RET number,
 * appears in one list and is deleted from one place. What differs is how much
 * is already known: the line names the shipment, the product and the bin, so
 * nothing is scanned and no tracking number is needed to link it. The goods go
 * straight back into the bin they were picked from — RESTOCKED on booking.
 *
 * The charge keeps the line's own rule: only the client's ITEM_RETURN rate,
 * and only when `chargeReturn` is true — an admin absorbing a return should
 * not have to remove a charge afterwards. No restock charge. The shipment's
 * own dispatch charge is never touched.
 *
 * `source` is what the two entry points below know about the line:
 *   line      { id, productId, quantity, returnedQuantity, sourceLocationId, trackingId? }
 *   shipment  { id, reference, status, clientId, trackingId }
 *   kind      'shipment' | 'bulk shipment', for sentences
 *   links     the record's shipment and line columns
 *   addReturned(tx)  counts `amount` against the line, conditionally; 0 = no room
 *   auditAction, auditIds
 */
const bookFromLine = async (source, { quantity, reason, chargeReturn = false }, actorUserId) => {
  if (!actorUserId) {
    throw new Error('An authenticated user is required to record a return.');
  }
  const { line, shipment, kind } = source;

  if (shipment.status !== 'DISPATCHED') {
    throw new Error(
      kind === 'bulk shipment'
        ? `Only a dispatched bulk shipment can have goods returned — this one is ${shipment.status}.`
        : `Only a dispatched shipment can have items returned — this one is ${shipment.status}. Use unpick or cancel instead.`,
    );
  }

  const amount = Number(quantity);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Return quantity must be a whole number above zero.');
  }
  const already = line.returnedQuantity ?? 0;
  const outstanding = line.quantity - already;
  if (amount > outstanding) {
    throw new Error(
      already > 0
        ? `Only ${outstanding} of this line is still out — ${already} of ${line.quantity} has already been returned.`
        : `Cannot return ${amount}; the line was only ${line.quantity}.`,
    );
  }
  const notes = reason ? String(reason).trim() || null : null;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const { created, charge } = await prisma.$transaction(async (tx) => {
        // Conditional, so a return booked against the same units a moment ago
        // cannot also fit.
        if ((await source.addReturned(amount, tx)) === 0) {
          throw withStatus(
            'Some of this line was returned at the same moment. Refresh and try again.',
            409,
          );
        }

        const reference = await nextReturnReference(tx);
        const now = new Date();
        const created = await productReturnRepository.createReturn(
          {
            reference,
            // The line's own consignment number, else the shipment's. Often
            // neither: the line is the link, not the label.
            trackingNumber: line.trackingId ?? shipment.trackingId ?? null,
            clientId: shipment.clientId,
            productId: line.productId,
            quantity: amount,
            status: 'RESTOCKED',
            ...source.links,
            restockLocationId: line.sourceLocationId,
            notes,
            recordedByUserId: actorUserId,
            resolvedByUserId: actorUserId,
            resolvedAt: now,
          },
          tx,
        );

        // The ledger applies the stock change itself — adding it here as well
        // would credit the shelf twice.
        await inventoryLedgerLogic.createInventoryLedger(
          {
            productId: line.productId,
            userId: actorUserId,
            movementType: 'RETURN',
            quantity: amount,
            toLocationId: line.sourceLocationId,
            referenceId: reference,
            notes: notes || `Returned from ${kind} ${shipment.reference}`,
          },
          { tx },
        );

        const charge = chargeReturn
          ? await raiseCharge({
              productReturn: created,
              rate: await getReturnRateForClient(shipment.clientId, tx),
              description: `Return handling — ${amount} item(s) from ${kind} ${shipment.reference}, return ${reference}`,
              itemType: 'MANUAL_CHARGE',
              tx,
            })
          : null;

        return { created, charge };
      }, TRANSACTION_OPTIONS);

      await audit(actorUserId, source.auditAction, {
        returnId: created.id,
        reference: created.reference,
        ...source.auditIds,
        clientId: shipment.clientId,
        productId: line.productId,
        toLocationId: line.sourceLocationId,
        quantity: amount,
        returnedTotal: already + amount,
        ofLineQuantity: line.quantity,
        reason: notes,
        // The dispatch charge is never rewritten. A return fee, when one
        // applies, is its own line.
        dispatchChargeChanged: false,
        chargeRequested: chargeReturn,
        returnCharge: charge?.amount ?? null,
      });

      return {
        ...(await productReturnRepository.getReturnById(created.id)),
        returnCharge: charge?.amount ?? null,
      };
    } catch (error) {
      if (attempt >= REFERENCE_ATTEMPTS || !isReferenceClash(error)) throw error;
    }
  }
};

/**
 * The outbound shipment line's Return button. See bookFromLine.
 *
 * @param {{ quantity: number, reason?: string, chargeReturn?: boolean }} options
 * @returns the return, plus `returnCharge`: the amount charged, or null
 */
const recordLineReturn = async (rawItemId, options = {}, actorUserId) => {
  const itemId = parseUuid(rawItemId, 'Shipment item');
  const item = itemId
    ? await prisma.shipmentItem.findUnique({
        where: { id: itemId },
        include: {
          shipment: {
            select: { id: true, reference: true, status: true, clientId: true, trackingId: true },
          },
        },
      })
    : null;
  if (!item) throw withStatus('Shipment item not found.', 404);

  return await bookFromLine(
    {
      line: item,
      shipment: item.shipment,
      kind: 'shipment',
      links: { shipmentId: item.shipment.id, shipmentItemId: item.id },
      addReturned: (amount, tx) => productReturnRepository.addReturnedQuantity(item.id, amount, tx),
      auditAction: 'SHIPMENT_ITEM_RETURNED',
      auditIds: { shipmentId: item.shipment.id, shipmentItemId: item.id },
    },
    options,
    actorUserId,
  );
};

/**
 * A bulk shipment line's Return button. See bookFromLine.
 *
 * @param {{ quantity: number, reason?: string, chargeReturn?: boolean }} options
 * @returns the return, plus `returnCharge`: the amount charged, or null
 */
const recordBulkLineReturn = async (rawShipmentId, rawItemId, options = {}, actorUserId) => {
  const shipmentId = parseUuid(rawShipmentId, 'Bulk shipment');
  const itemId = parseUuid(rawItemId, 'Bulk shipment line');
  const item =
    shipmentId && itemId
      ? await prisma.fbaShipmentItem.findUnique({
          where: { id: itemId },
          include: {
            fbaShipment: {
              select: { id: true, reference: true, status: true, clientId: true, trackingId: true },
            },
          },
        })
      : null;
  if (!item || item.fbaShipmentId !== shipmentId) {
    throw withStatus('That line was not found on this bulk shipment.', 404);
  }

  return await bookFromLine(
    {
      line: item,
      shipment: item.fbaShipment,
      kind: 'bulk shipment',
      links: { fbaShipmentId: item.fbaShipment.id, fbaShipmentItemId: item.id },
      addReturned: (amount, tx) =>
        productReturnRepository.addBulkReturnedQuantity(item.id, amount, tx),
      auditAction: 'FBA_SHIPMENT_ITEM_RETURNED',
      auditIds: { fbaShipmentId: item.fbaShipment.id, fbaShipmentItemId: item.id },
    },
    options,
    actorUserId,
  );
};

// ─── Resolve later: dispose or restock from the list ──────────────────────────

const resolveReturn = async (id, rawDisposition, actorUserId) => {
  if (!actorUserId) {
    throw new Error('An authenticated user is required to resolve a return.');
  }
  const disposition = await parseDisposition(rawDisposition);
  const existing = await requireReturn(id);
  if (existing.status !== 'RECORDED') throw alreadyResolved(existing);

  const { updated, charge } = await prisma.$transaction(async (tx) => {
    const charge = await applyDisposition(existing, disposition, actorUserId, tx);
    return { updated: await productReturnRepository.getReturnById(existing.id, tx), charge };
  }, TRANSACTION_OPTIONS);

  await auditDisposition(actorUserId, existing, disposition, charge);
  return { ...updated, charged: charge?.amount ?? null };
};

/**
 * Closes a return with the goods thrown away. Nothing further is charged — the
 * handling charge raised when it was recorded stands, because that work was
 * done. Stock is not touched: these units never went back on a shelf.
 */
const disposeReturn = (id, { notes } = {}, actorUserId) =>
  resolveReturn(id, { type: 'dispose', notes }, actorUserId);

/** Inspects a return and puts it back on a shelf, raising the restock charge. */
const restockReturn = (id, { locationId, notes } = {}, actorUserId) =>
  resolveReturn(id, { type: 'restock', locationId, notes }, actorUserId);

// ─── Reads ────────────────────────────────────────────────────────────────────

const getReturns = async ({ status } = {}) => {
  if (status && !RETURN_STATUSES.includes(status)) {
    throw new Error(`Unknown status: ${status}. Use one of ${RETURN_STATUSES.join(', ')}.`);
  }
  return await productReturnRepository.getReturns({ status });
};

const getReturnById = async (id) => await withDispositionHints(await requireReturn(id));

// ─── Edit ─────────────────────────────────────────────────────────────────────

/**
 * Corrects what was written about a return. Only the notes: everything else
 * was scanned, or decided and acted on — stock moved, a charge raised — and a
 * wrong scan is corrected by deleting the return and recording it again, which
 * undoes those as well.
 *
 * Disposition notes exist only once a decision has been made.
 */
const updateReturn = async (id, raw, actorUserId) => {
  const existing = await requireReturn(id);
  const tidy = (value) => (value === null || value === undefined ? null : String(value).trim() || null);

  const data = {};
  if (raw && 'notes' in raw) data.notes = tidy(raw.notes);
  if (raw && 'dispositionNotes' in raw) {
    if (existing.status === 'RECORDED') {
      throw new Error('There is no decision on this return yet, so nothing to note about it.');
    }
    data.dispositionNotes = tidy(raw.dispositionNotes);
  }
  if (Object.keys(data).length === 0) return existing;

  const updated = await productReturnRepository.updateReturn(existing.id, data);
  await audit(actorUserId, 'RETURN_UPDATED', {
    returnId: existing.id,
    reference: existing.reference,
    changed: Object.keys(data),
  });
  return updated;
};

// ─── Delete ───────────────────────────────────────────────────────────────────

/** The bin as people know it, for a sentence. */
const binName = (location) => location?.materializedPath || location?.locationName || 'its bin';

/**
 * What deleting a return would refuse on, and what it would undo. See
 * utils/dependents.js for what blocking and removedWith mean.
 *
 * A return is deleted when it should never have been booked — the wrong
 * parcel, the wrong product, booked twice. Deleting it undoes everything
 * booking it did: the units come back off the shelf they were restocked to,
 * its charges come off the invoice, and the shipment line it was counted
 * against counts them as still out.
 *
 * Blocking:
 *  - a charge on a PAID invoice, as with a shipment: money that has changed
 *    hands is reversed with a credit note
 *  - restocked units that are no longer free on that shelf — picked, reserved
 *    or moved since. Taking them off anyway would push the count below what is
 *    physically there.
 */
const getReturnDependents = async (id) => {
  const productReturn = await requireReturn(id);
  const restocked = productReturn.status === 'RESTOCKED' && productReturn.restockLocationId;

  const [charges, free] = await Promise.all([
    prisma.invoiceLineItem.findMany({
      where: { returnId: productReturn.id },
      select: { id: true, invoiceId: true, invoice: { select: { status: true } } },
    }),
    restocked
      ? freeUnitsIn(productReturn.productId, productReturn.restockLocationId)
      : Promise.resolve(0),
  ]);
  const paid = paidAmong(charges).length;
  const shortfall = restocked ? Math.max(0, productReturn.quantity - free) : 0;

  return {
    productReturn,
    charges,
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
          key: 'stockGone',
          label: 'Restocked units no longer free on the shelf',
          count: shortfall,
          where: '/inventory',
          note:
            `Only ${free} of the ${productReturn.quantity} units put back into ` +
            `${binName(productReturn.restockLocation)} are still free there — the rest have been ` +
            'reserved, picked or moved since.',
        },
      ],
      removedWith: [
        {
          key: 'units',
          label: `Units taken back off ${binName(productReturn.restockLocation)}`,
          count: restocked ? productReturn.quantity : 0,
        },
        {
          key: 'charges',
          label: 'Charges taken off unpaid invoices',
          count: charges.length - paid,
          where: '/invoices',
        },
        {
          key: 'lineCount',
          label: productReturn.fbaShipmentItemId
            ? `Units counted as returned on bulk shipment ${productReturn.fbaShipment?.reference ?? ''}`.trim()
            : `Units counted as returned on shipment ${productReturn.shipment?.reference ?? ''}`.trim(),
          count:
            productReturn.shipmentItemId || productReturn.fbaShipmentItemId ? productReturn.quantity : 0,
          note: 'They count as still with the customer again.',
        },
      ],
    }),
  };
};

const deleteReturn = async (id, actorUserId) => {
  if (!actorUserId) {
    throw new Error('An authenticated user is required to delete a return.');
  }
  const { productReturn, report } = await getReturnDependents(id);
  assertDeletable(`Return ${productReturn.reference}`, report);

  const restocked = productReturn.status === 'RESTOCKED' && productReturn.restockLocationId;

  const removedCharges = await prisma.$transaction(async (tx) => {
    // Re-read inside the transaction: the warning was a minute ago.
    const charges = await tx.invoiceLineItem.findMany({
      where: { returnId: productReturn.id },
      include: { invoice: { select: { status: true } } },
    });
    if (paidAmong(charges).length > 0) {
      throw withStatus(
        `A charge for return ${productReturn.reference} is on a paid invoice — raise a credit note instead.`,
        409,
      );
    }

    if (productReturn.shipmentItemId) {
      // The line can be short only if its count was edited by hand; the
      // return is still deleted, the line just has nothing left to give back.
      await productReturnRepository.takeBackReturnedQuantity(
        productReturn.shipmentItemId,
        productReturn.quantity,
        tx,
      );
    }
    if (productReturn.fbaShipmentItemId) {
      await productReturnRepository.takeBackBulkReturnedQuantity(
        productReturn.fbaShipmentItemId,
        productReturn.quantity,
        tx,
      );
    }

    if (restocked) {
      await takeOffShelf(
        {
          productId: productReturn.productId,
          locationId: productReturn.restockLocationId,
          quantity: productReturn.quantity,
          reference: productReturn.reference,
          notes: `Return ${productReturn.reference} deleted — restock reversed`,
          actorUserId,
        },
        tx,
      );
    }

    await removeChargeLines(charges, tx);
    await productReturnRepository.deleteReturn(productReturn.id, tx);
    return charges.length;
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'RETURN_DELETED', {
    returnId: productReturn.id,
    reference: productReturn.reference,
    status: productReturn.status,
    clientId: productReturn.clientId,
    productId: productReturn.productId,
    quantity: productReturn.quantity,
    shipmentId: productReturn.shipmentId,
    shipmentItemId: productReturn.shipmentItemId,
    fbaShipmentId: productReturn.fbaShipmentId,
    fbaShipmentItemId: productReturn.fbaShipmentItemId,
    unitsTakenOff: restocked ? productReturn.quantity : 0,
    fromLocationId: restocked ? productReturn.restockLocationId : null,
    chargesRemoved: removedCharges,
  });

  return { id: productReturn.id };
};

// ─── What a viewer is shown ───────────────────────────────────────────────────

/**
 * Takes the money out of a response for anyone but an admin.
 *
 * Rate cards and invoices are admin-only everywhere else in the system, and a
 * returns screen is not a reason for an employee to learn what a client pays.
 * What the bench does need is whether a charge applies, so that survives as a
 * flag.
 */
/** A rate becomes "a charge applies" (true) or "none" (null) — never an amount. */
const redactRates = (rates) => ({
  returnHandling: rates.returnHandling > 0 ? true : null,
  restock: rates.restock > 0 ? true : null,
});

const redactMoney = (data, role) => {
  if (role === 'admin' || data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map((row) => redactMoney(row, role));

  const out = { ...data };

  if ('invoiceLines' in out) {
    out.charged = Array.isArray(out.invoiceLines) && out.invoiceLines.length > 0;
    out.chargeCount = Array.isArray(out.invoiceLines) ? out.invoiceLines.length : 0;
    delete out.invoiceLines;
  } else if ('charged' in out) {
    out.charged = out.charged !== null && out.charged !== undefined;
  }

  if (out.rates) out.rates = redactRates(out.rates);

  if (Array.isArray(out.products)) {
    out.products = out.products.map((p) => ({
      ...p,
      rates: p.rates ? redactRates(p.rates) : p.rates,
    }));
  }

  return out;
};

module.exports = {
  identify,
  findLinesForProduct,
  recordReturn,
  recordLineReturn,
  recordBulkLineReturn,
  disposeReturn,
  restockReturn,
  getReturns,
  getReturnById,
  updateReturn,
  getReturnDependents,
  deleteReturn,
  redactMoney,
  RETURN_STATUSES,
  // Exported for tests.
  nextReturnReference,
  resolveLink,
};
