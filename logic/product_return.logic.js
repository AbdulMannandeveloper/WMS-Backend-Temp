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

// ─── Charging ─────────────────────────────────────────────────────────────────

/**
 * Raises one charge for a return onto the client's open invoice.
 *
 * Returns null — and raises nothing — when the client has no agreed rate or it
 * is zero. That is an arrangement, not an error: the goods are handled either
 * way, and an invoice is not opened just to hold no lines.
 */
const raiseCharge = async ({ productReturn, rate, description, tx }) => {
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
      // Raised by an operational trigger — the scan at the bench — rather than
      // typed in by an admin.
      itemType: 'AUTOMATED_SERVICE',
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
 * @param {{ trackingNumber: string, productId: string, quantity?: number, notes?: string,
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
        const link = resolveLink(candidates, product);

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
  recordReturn,
  disposeReturn,
  restockReturn,
  getReturns,
  getReturnById,
  redactMoney,
  RETURN_STATUSES,
  // Exported for tests.
  nextReturnReference,
  resolveLink,
};
