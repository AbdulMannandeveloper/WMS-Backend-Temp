'use strict';

/**
 * The services the system raises for itself, and the standing monthly charges.
 *
 * Two gaps this closes.
 *
 * The shipment charge used to be a bare Decimal column on Client
 * (fixed_shipment_rate). Nothing in the application could write it — not the
 * update allowlist, not any route, not the frontend — so every client sat at
 * 0.00 and the dispatch path, which skips a zero rate, never raised a charge for
 * anyone. It is a catalogue Service now, priced per client through the same
 * ClientService rate card as everything else: settable, with a unit, visible in
 * the client's service list, and subject to the existing price-freezing.
 *
 * And a client who takes storage or a retainer but never ships had no automated
 * route to an invoice at all, because line items were only ever created at
 * dispatch. A ClientService can now be marked recurring and is raised every
 * period whether or not anything moved.
 */

const monthlyInvoiceRepository = require('../repositories/monthly_invoice.repository');
const { firstOfMonthUtc, addMonthsUtc } = require('../utils/dates');
const clientServiceRepository = require('../repositories/client_service.repository');
const invoiceLineItemRepository = require('../repositories/invoice_line_item.repository');
const { prisma } = require('../lib/prisma');

const db = (tx) => tx || prisma;

/** The catalogue code for the charge raised when a shipment is dispatched. */
const SHIPMENT_SERVICE_CODE = 'SHIPMENT_DISPATCH';

/** The catalogue code for an FBA consignment leaving. */
const FBA_SERVICE_CODE = 'FBA_DISPATCH';

/**
 * The shipment-dispatch service row, created on first use.
 *
 * Seeded lazily rather than in a migration so a fresh database, a test database
 * and an existing one all end up in the same place without a data migration
 * that has to guess at a price.
 */
const ensureShipmentService = async (tx) => {
  const existing = await db(tx).service.findUnique({
    where: { code: SHIPMENT_SERVICE_CODE },
  });
  if (existing) return existing;

  return await db(tx).service.create({
    data: {
      code: SHIPMENT_SERVICE_CODE,
      description: 'Shipment dispatch (per item)',
      // The list price. What a client actually pays is their ClientService rate.
      ideaPrice: '0.00',
      unit: 'item',
    },
  });
};

/**
 * How many items a shipment is billed for.
 *
 * The sum of the line quantities, not the number of lines: shipping twenty of
 * one SKU is twenty items, and charging that as one is the difference between
 * the invoice and the work. The old code hardcoded quantity: 1, so a
 * five-hundred-item shipment billed the same as a single-item one.
 */
const countShippedItems = (shipmentItems) =>
  shipmentItems.reduce((total, item) => total + Number(item.quantity || 0), 0);

/**
 * The client's agreed per-item rate for dispatch, or null if they have not
 * bought that service — which is a real arrangement, not an error: a
 * services-only client stores and is handled here but ships through someone
 * else.
 */
const getRateForClient = async (clientId, code, tx) => {
  const service = await db(tx).service.findUnique({ where: { code } });
  if (!service) return null;

  const rate = await clientServiceRepository.getClientServiceByClientIdAndServiceId(
    clientId,
    service.id,
  );
  if (!rate) return null;

  return { clientService: rate, unitPrice: rate.chargedPrice };
};

const getShipmentRateForClient = (clientId, tx) =>
  getRateForClient(clientId, SHIPMENT_SERVICE_CODE, tx);

/** The client's agreed per-item rate for an FBA consignment, or null. */
const getFbaRateForClient = (clientId, tx) =>
  getRateForClient(clientId, FBA_SERVICE_CODE, tx);

/** The FBA charge service row, created on first use. Mirrors the dispatch one. */
const ensureFbaService = async (tx) => {
  const existing = await db(tx).service.findUnique({ where: { code: FBA_SERVICE_CODE } });
  if (existing) return existing;

  return await db(tx).service.create({
    data: {
      code: FBA_SERVICE_CODE,
      description: 'FBA consignment (per item)',
      ideaPrice: '0.00',
      unit: 'item',
    },
  });
};

/**
 * Adds this period's standing charges to an invoice, once.
 *
 * Idempotent by design: it is called whenever an invoice is opened or topped up,
 * which for a shipping client happens on every dispatch. Re-running it must not
 * bill storage twice, so an existing RECURRING_SERVICE line for the same
 * clientService on the same invoice means the work is already done.
 */
const applyRecurringCharges = async (clientId, invoice, tx) => {
  const recurring = await db(tx).clientService.findMany({
    where: { clientId, isRecurring: true },
    include: { service: true },
  });
  if (recurring.length === 0) return [];

  const already = await db(tx).invoiceLineItem.findMany({
    where: { invoiceId: invoice.id, itemType: 'RECURRING_SERVICE' },
    select: { clientServiceId: true },
  });
  const billed = new Set(already.map((l) => l.clientServiceId));

  const created = [];
  for (const rate of recurring) {
    if (billed.has(rate.id)) continue;

    const quantity = Number(rate.recurringQuantity ?? 1);
    const unitPrice = Number(rate.chargedPrice);

    created.push(
      await invoiceLineItemRepository.createInvoiceLineItem(
        {
          invoiceId: invoice.id,
          clientServiceId: rate.id,
          quantity,
          unitPrice,
          totalPrice: Number((quantity * unitPrice).toFixed(2)),
          description: `${rate.service?.description || 'Recurring service'} — standing monthly charge`,
          // The period being billed, not today: a charge raised late still
          // belongs to the month it covers.
          dateOfService: invoice.billingPeriod,
          itemType: 'RECURRING_SERVICE',
        },
        tx,
      ),
    );
  }

  return created;
};

/**
 * Finds the invoice a new charge should land on, creating it if needed.
 *
 * Normally the current month's. If that has been APPROVED or PAID the charge
 * rolls forward to the next open period rather than being refused: a closed
 * accounting period should never block goods leaving, and the charge must not be
 * silently dropped either. The line's dateOfService still records when the work
 * happened, so a later-period invoice explains itself.
 *
 * Rolling forward rather than opening a second invoice for the same month is
 * also forced by the schema — monthly_invoices is unique on (client, period).
 *
 * Lives here rather than in shipment.logic so FBA and ordinary dispatch resolve
 * a period the same way. Two copies of this rule is how a client once ended up
 * with two invoices for one month.
 */
const resolveOpenInvoiceFor = async (clientId, tx, maxLookahead = 12) => {
  let period = firstOfMonthUtc();

  for (let i = 0; i <= maxLookahead; i++) {
    const existing = await monthlyInvoiceRepository.getMonthlyInvoiceByClientIdAndMonth(
      clientId,
      period,
      tx,
    );

    if (!existing) {
      const created = await monthlyInvoiceRepository.createMonthlyInvoice(
        { clientId, billingPeriod: period, status: 'DRAFT' },
        tx,
      );
      await applyRecurringCharges(clientId, created, tx);
      return created;
    }

    if (existing.status === 'DRAFT') {
      await applyRecurringCharges(clientId, existing, tx);
      return existing;
    }

    period = addMonthsUtc(period, 1);
  }

  throw new Error(
    'Could not find an open invoice to bill this to — every period for the next year is already closed.',
  );
};

/**
 * Charges a quantity of a service a client has already agreed a rate for,
 * straight onto their open invoice.
 *
 * For work that happened once and is not tied to a shipment — an hour of
 * re-labelling, a pallet rewrapped, a special delivery. The recurring flag
 * covers the predictable monthly charges; this covers everything else, and
 * between them a client with no shipments at all can still be billed.
 *
 * Only services the client already has a rate for: inventing a price at the
 * point of charging is how a client gets billed something nobody agreed.
 */
const chargeServiceToClient = async (
  { clientId, clientServiceId, quantity, description },
  tx,
) => {
  const amount = Number(quantity);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Quantity must be above zero.');
  }

  const rate = await db(tx).clientService.findUnique({
    where: { id: clientServiceId },
    include: { service: true },
  });
  if (!rate) {
    throw new Error('That agreed rate does not exist.');
  }
  if (rate.clientId !== clientId) {
    throw new Error('That rate belongs to a different client.');
  }

  const unitPrice = Number(rate.chargedPrice);
  const invoice = await resolveOpenInvoiceFor(clientId, tx);

  const line = await invoiceLineItemRepository.createInvoiceLineItem(
    {
      invoiceId: invoice.id,
      clientServiceId: rate.id,
      quantity: amount,
      unitPrice,
      totalPrice: Number((amount * unitPrice).toFixed(2)),
      description:
        description ||
        `${rate.service?.description || 'Service'} — ${amount} ${rate.unit || 'unit'}(s)`,
      dateOfService: new Date(),
      itemType: 'MANUAL_CHARGE',
    },
    tx,
  );

  // Derived from the lines, never accumulated.
  const { _sum } = await db(tx).invoiceLineItem.aggregate({
    where: { invoiceId: invoice.id },
    _sum: { totalPrice: true },
  });
  await db(tx).monthlyInvoice.update({
    where: { id: invoice.id },
    data: { totalAmount: _sum.totalPrice ?? 0 },
  });

  return { line, invoice };
};

module.exports = {
  SHIPMENT_SERVICE_CODE,
  FBA_SERVICE_CODE,
  ensureShipmentService,
  ensureFbaService,
  countShippedItems,
  getRateForClient,
  getShipmentRateForClient,
  getFbaRateForClient,
  applyRecurringCharges,
  resolveOpenInvoiceFor,
  chargeServiceToClient,
};
