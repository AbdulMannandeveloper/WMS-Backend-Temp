const { prisma } = require("../lib/prisma");
const { assertAllowedField } = require("../utils/pick");

// An invoice is a client's billing record, so a dynamic column here is the
// wrong thing to leave open next to a clientId query parameter.
const INVOICE_QUERY_FIELDS = ["id", "clientId", "status", "billingPeriod"];

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

/**
 * @param {object} where - a Prisma where; {} matches everything.
 * @param {object} [options]
 * @param {object[]} [options.orderBy]
 * @param {object} [options.pagination] - absent, the whole set comes back bare.
 */
const getAllMonthlyInvoices = async (where = {}, { orderBy, pagination, tx } = {}) => {
  const client = db(tx);
  const sort = orderBy || [
    { billingPeriod: "desc" },
    { createdAt: "desc" },
    { id: "asc" },
  ];

  if (pagination && pagination.take != null) {
    const [items, total] = await Promise.all([
      client.monthlyInvoice.findMany({
        where,
        include: includeRelations,
        orderBy: sort,
        skip: pagination.skip || 0,
        take: pagination.take,
      }),
      client.monthlyInvoice.count({ where }),
    ]);
    return { items, total };
  }

  return await client.monthlyInvoice.findMany({
    where,
    include: includeRelations,
    orderBy: sort,
  });
};

/**
 * Totals across the whole filtered set, not the page.
 *
 * grandTotal is summed rather than derived here because the database already
 * derives it: total_amount + tax_amount, computed by Postgres. Adding the two
 * sums in JavaScript would give the same number today and drift the first time
 * one of the three writers of those columns forgets the other.
 */
const summariseMonthlyInvoices = async (where = {}, tx) => {
  const client = db(tx);
  const [aggregate, byStatus, outstanding] = await Promise.all([
    client.monthlyInvoice.aggregate({
      where,
      _count: { _all: true },
      _sum: { totalAmount: true, taxAmount: true, grandTotal: true },
    }),
    client.monthlyInvoice.groupBy({
      by: ["status"],
      where,
      _count: { _all: true },
    }),
    // What is owed: everything the client has not paid for yet.
    client.monthlyInvoice.aggregate({
      where: { AND: [where, { status: { not: "PAID" } }] },
      _sum: { grandTotal: true },
    }),
  ]);

  const counts = { DRAFT: 0, APPROVED: 0, PAID: 0 };
  for (const row of byStatus) counts[row.status] = row._count._all;

  return {
    total: aggregate._count._all,
    byStatus: counts,
    totalNet: (aggregate._sum.totalAmount ?? 0).toString(),
    totalTax: (aggregate._sum.taxAmount ?? 0).toString(),
    totalGrand: (aggregate._sum.grandTotal ?? 0).toString(),
    outstandingGrand: (outstanding._sum.grandTotal ?? 0).toString(),
  };
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
  assertAllowedField(field, INVOICE_QUERY_FIELDS);
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
  summariseMonthlyInvoices,
  createMonthlyInvoice,
  getAllMonthlyInvoices,
  getMonthlyInvoiceByClientIdAndMonth,
  getMonthlyInvoiceById,
  getMonthlyInvoiceByField,
  updateMonthlyInvoice,
  deleteMonthlyInvoice,
  recalculateInvoiceTotal,
};
