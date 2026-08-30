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

/** The catalogue code for an FDA consignment leaving. */
const FDA_SERVICE_CODE = 'FDA_DISPATCH';

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

/** The client's agreed per-item rate for an FDA consignment, or null. */
const getFdaRateForClient = (clientId, tx) =>
  getRateForClient(clientId, FDA_SERVICE_CODE, tx);

/** The FDA charge service row, created on first use. Mirrors the dispatch one. */
const ensureFdaService = async (tx) => {
  const existing = await db(tx).service.findUnique({ where: { code: FDA_SERVICE_CODE } });
  if (existing) return existing;

  return await db(tx).service.create({
    data: {
      code: FDA_SERVICE_CODE,
      description: 'FDA consignment (per item)',
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
 * Lives here rather than in shipment.logic so FDA and ordinary dispatch resolve
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

module.exports = {
  SHIPMENT_SERVICE_CODE,
  FDA_SERVICE_CODE,
  ensureShipmentService,
  ensureFdaService,
  countShippedItems,
  getRateForClient,
  getShipmentRateForClient,
  getFdaRateForClient,
  applyRecurringCharges,
  resolveOpenInvoiceFor,
};
