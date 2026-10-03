'use strict';

/**
 * Undoing a return: the pieces shared by deleting a return record
 * (product_return.logic) and undoing the returns booked on a shipment's lines
 * (shipment.logic). Both put units back on a shelf and may have charged for it;
 * undoing either takes the units off again and the charges off the invoice.
 *
 * The ledger is never rewritten. The RETURN movement stays where it is, and a
 * reversing movement is written after it, so the history reads as what
 * happened: the goods were booked back in, then that was found to be wrong.
 */

const { prisma } = require('../lib/prisma');
const invoiceLineItemRepository = require('../repositories/invoice_line_item.repository');
const monthlyInvoiceRepository = require('../repositories/monthly_invoice.repository');
const inventoryLedgerLogic = require('./inventory_ledger.logic');

const db = (tx) => tx || prisma;

/**
 * Units of a product in a bin that nothing has reserved — all a reversal may
 * take. Units since reserved for a shipment are somebody's pick tomorrow.
 */
const freeUnitsIn = async (productId, locationId, tx) => {
  const row = await db(tx).stockLevel.findUnique({
    where: { productId_locationId: { productId, locationId } },
    select: { currentQuantity: true, reservedQuantity: true },
  });
  return row ? Math.max(0, row.currentQuantity - row.reservedQuantity) : 0;
};

/**
 * Takes returned units back off the shelf, inside the caller's transaction.
 *
 * An ADJUSTMENT — the correction movement — rather than a CHECKOUT, which has
 * to name a shipment the goods left on, and these are not leaving: they were
 * never really back. It subtracts only from unreserved stock, so it fails
 * rather than pull units out from under a pick.
 */
const takeOffShelf = async ({ productId, locationId, quantity, reference, notes, actorUserId }, tx) =>
  await inventoryLedgerLogic.createInventoryLedger(
    {
      productId,
      userId: actorUserId,
      movementType: 'ADJUSTMENT',
      quantity,
      fromLocationId: locationId,
      referenceId: reference,
      notes,
    },
    { tx },
  );

/** Charge lines on a PAID invoice. Those are reversed with a credit note, never deleted. */
const paidAmong = (lines) => lines.filter((line) => line.invoice?.status === 'PAID');

/**
 * Deletes charge lines and recomputes each invoice they were on. Lines are the
 * rows a caller found with `include: { invoice: { select: { status } } }`; it
 * has already refused anything paid.
 */
const removeChargeLines = async (lines, tx) => {
  const invoiceIds = new Set(lines.map((line) => line.invoiceId));
  for (const line of lines) {
    await invoiceLineItemRepository.deleteInvoiceLineItem(line.id, tx);
  }
  for (const invoiceId of invoiceIds) {
    await monthlyInvoiceRepository.recalculateInvoiceTotal(invoiceId, tx);
  }
};

module.exports = { freeUnitsIn, takeOffShelf, paidAmong, removeChargeLines };
