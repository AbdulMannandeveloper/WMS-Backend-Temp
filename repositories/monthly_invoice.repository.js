const { prisma } = require("../lib/prisma");

const includeRelations = {
  client: {
    select: {
      id: true,
      companyName: true,
      contactName: true,
      email: true,
    },
  },
  lineItems: {
    include: {
      clientService: {
        include: { service: true },
      },
    },
    orderBy: { dateOfService: "desc" },
  },
};

const db = (tx) => tx || prisma;

const createMonthlyInvoice = async (invoiceData, tx) => {
  return await db(tx).monthlyInvoice.create({ data: invoiceData });
};

const getAllMonthlyInvoices = async (tx) => {
  return await db(tx).monthlyInvoice.findMany({
    include: includeRelations,
    orderBy: { billingPeriod: "desc" },
  });
};

const getMonthlyInvoiceByClientIdAndMonth = async (clientId, billingMonth, tx) => {
  return await db(tx).monthlyInvoice.findUnique({
    where: {
      clientId_billingPeriod: {
        clientId: clientId,
        billingPeriod: billingMonth,
      },
    },
    include: includeRelations,
  });
};

const getMonthlyInvoiceById = async (id, tx) => {
  return await db(tx).monthlyInvoice.findUnique({
    where: { id },
    include: includeRelations,
  });
};

const getMonthlyInvoiceByField = async (field, value, tx) => {
  return await db(tx).monthlyInvoice.findMany({
    where: {
      [field]: value,
    },
    include: includeRelations,
    orderBy: { billingPeriod: "desc" },
  });
};

const updateMonthlyInvoice = async (id, updateData, tx) => {
  return await db(tx).monthlyInvoice.update({
    where: { id },
    data: updateData,
    include: includeRelations,
  });
};

const deleteMonthlyInvoice = async (id, tx) => {
  return await db(tx).monthlyInvoice.delete({
    where: { id },
  });
};

/**
 * Recomputes an invoice's total from its line items and writes it back.
 *
 * `totalAmount` is a projection of SUM(invoice_line_items.total_price), never a
 * running balance — a derived total cannot drift, and can be re-derived at any
 * point if something upstream goes wrong.
 *
 * The addition happens in Postgres against numeric(14,2), and Prisma hands back
 * a Decimal that goes straight into a Decimal column. Nothing is summed in
 * JavaScript, which is deliberate: a Prisma Decimal stringifies through
 * valueOf(), so `decimal + number` concatenates rather than adds. That is
 * exactly how a £100 invoice once became £10,050. Keep money arithmetic in the
 * database and the whole class of bug goes away.
 *
 * Pass `tx` to join the caller's transaction — the total must land in the same
 * commit as the line item that changed it.
 */
/**
 * Re-derives the invoice total from its line items.
 *
 * totalAmount is EX-TAX — the sum of the lines and nothing else. Tax is held
 * separately because profit_loss reads totalAmount as company earnings, and VAT
 * is collected for HMRC rather than earned.
 *
 * When tax is applied, taxAmount is recomputed here too. That matters: a
 * dispatch during the month adds a line, which moves the subtotal, and a tax
 * figure calculated once at the moment the checkbox was ticked would quietly go
 * stale and undercharge for the rest of the period.
 */
const recalculateInvoiceTotal = async (invoiceId, tx) => {
  const { _sum } = await db(tx).invoiceLineItem.aggregate({
    where: { invoiceId },
    _sum: { totalPrice: true },
  });

  // _sum.totalPrice is null when an invoice has no line items.
  const subtotal = _sum.totalPrice ?? 0;

  const invoice = await db(tx).monthlyInvoice.findUnique({
    where: { id: invoiceId },
    select: { taxApplied: true, taxRate: true },
  });

  const taxAmount =
    invoice?.taxApplied && invoice.taxRate != null
      ? Number(((Number(subtotal) * Number(invoice.taxRate)) / 100).toFixed(2))
      : 0;

  return await db(tx).monthlyInvoice.update({
    where: { id: invoiceId },
    data: { totalAmount: subtotal, taxAmount },
    include: includeRelations,
  });
};

module.exports = {
  createMonthlyInvoice,
  getAllMonthlyInvoices,
  getMonthlyInvoiceByClientIdAndMonth,
  getMonthlyInvoiceById,
  getMonthlyInvoiceByField,
  updateMonthlyInvoice,
  deleteMonthlyInvoice,
  recalculateInvoiceTotal,
};
