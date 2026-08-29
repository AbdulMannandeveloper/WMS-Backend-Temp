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
const recalculateInvoiceTotal = async (invoiceId, tx) => {
  const { _sum } = await db(tx).invoiceLineItem.aggregate({
    where: { invoiceId },
    _sum: { totalPrice: true },
  });

  // _sum.totalPrice is null when an invoice has no line items.
  return await db(tx).monthlyInvoice.update({
    where: { id: invoiceId },
    data: { totalAmount: _sum.totalPrice ?? 0 },
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
