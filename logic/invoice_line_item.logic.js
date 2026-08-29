const { prisma } = require("../lib/prisma");
const invoiceLineItemRepository = require("../repositories/invoice_line_item.repository");
const monthlyInvoiceRepository = require("../repositories/monthly_invoice.repository");

/**
 * Line items own the invoice total.
 *
 * Every mutation here writes the line item and re-derives
 * monthly_invoices.total_amount in the same transaction, so the two can never
 * disagree — see recalculateInvoiceTotal in the monthly invoice repository for
 * why the sum is computed in Postgres rather than in JavaScript.
 *
 * Each function takes `{ tx }` to join an outer interactive transaction, the
 * same pattern createInventoryLedger uses in inventory_ledger.logic.js. Callers
 * already inside a transaction (shipment dispatch) must pass it: Prisma cannot
 * nest interactive transactions.
 */

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

/** Runs `fn` in the caller's transaction, or opens one if there isn't one. */
const inTransaction = (options, fn) =>
  options.tx ? fn(options.tx) : prisma.$transaction(fn, TRANSACTION_OPTIONS);

const createInvoiceLineItem = async (data, options = {}) => {
  // Check for required fields
  if (!data.invoiceId || !data.quantity || !data.unitPrice) {
    throw new Error(
      "Monthly Invoice ID, quantity, and unit price are required to create an invoice line item.",
    );
  }
  if (data.quantity <= 0) {
    throw new Error("Quantity must be greater than zero.");
  }
  if (data.unitPrice < 0) {
    throw new Error("Unit price cannot be negative.");
  }
  if (!data.description) {
    data.description = "No description provided"; // Default description if not provided
  }
  if (!data.dateOfService) {
    data.dateOfService = new Date(); // Default to current date if not provided
  }

  if (!data.itemType) {
    data.itemType = "AUTOMATED_SERVICE"; // Default item type if not provided
  }

  // One line's own extension. Number() on both operands because these may
  // arrive as Prisma Decimals from an internal caller, and `decimal * number`
  // is only correct by accident — unlike `+`, which concatenates.
  if (!data.totalPrice) {
    data.totalPrice = Number(data.quantity) * Number(data.unitPrice);
  }

  return inTransaction(options, async (tx) => {
    // Existence checked inside the transaction so the invoice cannot be deleted
    // between the check and the write.
    const monthlyInvoice = await monthlyInvoiceRepository.getMonthlyInvoiceById(
      data.invoiceId,
      tx,
    );
    if (!monthlyInvoice) {
      throw new Error("Monthly invoice not found.");
    }

    const invoiceLineItem =
      await invoiceLineItemRepository.createInvoiceLineItem(data, tx);

    await monthlyInvoiceRepository.recalculateInvoiceTotal(data.invoiceId, tx);

    return invoiceLineItem;
  });
};

const getInvoiceLineItemsByField = async (field, value) => {
  return await invoiceLineItemRepository.getInvoiceLineItemsByField(
    field,
    value,
  );
};

const updateInvoiceLineItem = async (id, data, options = {}) => {
  return inTransaction(options, async (tx) => {
    const existing = await invoiceLineItemRepository.getInvoiceLineItemsByField(
      "id",
      id,
      tx,
    );
    const item = Array.isArray(existing) ? existing[0] : existing;
    if (!item) {
      throw new Error("Invoice line item not found.");
    }

    const updated = await invoiceLineItemRepository.updateInvoiceLineItem(
      id,
      data,
      tx,
    );

    // Editing quantity or price moves the invoice total with it.
    await monthlyInvoiceRepository.recalculateInvoiceTotal(item.invoiceId, tx);

    return updated;
  });
};

const deleteInvoiceLineItem = async (id, options = {}) => {
  return inTransaction(options, async (tx) => {
    const existing = await invoiceLineItemRepository.getInvoiceLineItemsByField(
      "id",
      id,
      tx,
    );
    const item = Array.isArray(existing) ? existing[0] : existing;
    if (!item) {
      throw new Error("Invoice line item not found.");
    }

    const deleted = await invoiceLineItemRepository.deleteInvoiceLineItem(id, tx);

    await monthlyInvoiceRepository.recalculateInvoiceTotal(item.invoiceId, tx);

    return deleted;
  });
};

module.exports = {
  createInvoiceLineItem,
  getInvoiceLineItemsByField,
  updateInvoiceLineItem,
  deleteInvoiceLineItem,
};
