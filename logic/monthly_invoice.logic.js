const monthlyInvoiceRepository = require("../repositories/monthly_invoice.repository");
const invoiceLineItemRepository = require("../repositories/invoice_line_item.repository");

const clientLogic = require("./client.logic");
const { firstOfMonthUtc } = require("../utils/dates");
const { enqueueMail } = require("../utils/mailQueue");
const { invoiceApprovedEmailTemplate } = require("../utils/emailTemplates");

const auditLogLogic = require("./audit_log.logic");
const { renderInvoicePdf, invoicePdfKey } = require("../utils/invoicePdf");
// Held as a module rather than destructured: the storage functions are called
// through it so the failure path stays reachable from a test.
const objectStorage = require("../lib/objectStorage");

const APP_BASE_URL = process.env.APP_BASE_URL || "https://myapp.com";

/**
 * The invoice lifecycle, stated in one place the way SHIPMENT_TRANSITIONS is in
 * shipment.logic.js.
 *
 * PAID is terminal. Everything past DRAFT is a document the client has already
 * been sent, so it is credited rather than edited or deleted.
 */
const INVOICE_TRANSITIONS = {
  DRAFT: ["APPROVED"],
  APPROVED: ["PAID"],
  PAID: [],
};

/** Only a DRAFT invoice accepts line-item changes or deletion. */
const isEditable = (status) => status === "DRAFT";

const assertTransition = (from, to) => {
  const allowed = INVOICE_TRANSITIONS[from];
  if (!allowed) {
    throw new Error(`Invoice has an unrecognised status: ${from}.`);
  }
  if (!allowed.includes(to)) {
    const options = allowed.length
      ? allowed.join(", ")
      : "nothing — it is a final state";
    throw new Error(
      `A ${from} invoice cannot become ${to}. Allowed from ${from}: ${options}.`,
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

const createMonthlyInvoice = async (data) => {
  // Check for required fields
  if (!data.clientId) {
    throw new Error("Client ID is required to create a monthly invoice.");
  }

  const client = await clientLogic.getClientById(data.clientId);
  if (!client) {
    throw new Error("Client not found.");
  }

  // A new invoice has no line items, so its derived total is always zero.
  if (data.totalAmount !== undefined) {
    throw new Error(
      "Total amount cannot be set directly. It is derived from the invoice's line items.",
    );
  }

  if (!data.billingPeriod) {
    // Default to the 1st of the current month. UTC, because billing_period is a
    // @db.Date: a local-time 1st is stored as the previous month's last day
    // anywhere east of UTC.
    data.billingPeriod = firstOfMonthUtc();
  }
  if (!data.status) {
    data.status = "DRAFT"; // Default status
  }
  return await monthlyInvoiceRepository.createMonthlyInvoice(data);
};

const getAllMonthlyInvoices = async () => {
  return await monthlyInvoiceRepository.getAllMonthlyInvoices();
};

const getMonthlyInvoiceById = async (id) => {
  return await monthlyInvoiceRepository.getMonthlyInvoiceById(id);
};

const getMonthlyInvoiceByClientIdForMonth = async (clientId, billingPeriod) => {
  //  Billing period is stored as the first day of the month, so we create a date object for the first day of the current month to use as a filter when retrieving invoices for the client.
  const billingMonth = firstOfMonthUtc(billingPeriod);

  return await monthlyInvoiceRepository.getMonthlyInvoiceByClientIdAndMonth(
    clientId,
    billingMonth,
  );
};

const getMonthlyInvoiceByField = async (field, value) => {
  return await monthlyInvoiceRepository.getMonthlyInvoiceByField(field, value);
};

const updateMonthlyInvoice = async (id, data) => {
  if (data.clientId) {
    const client = await clientLogic.getClientById(data.clientId);
    if (!client) {
      throw new Error("Client not found.");
    }
  }
  const existingInvoice =
    await monthlyInvoiceRepository.getMonthlyInvoiceById(id);
  if (!existingInvoice) {
    throw new Error("Monthly invoice not found.");
  }

  // totalAmount is derived from the invoice's line items and is never written
  // directly — see recalculateInvoiceTotal in the repository. A caller supplying
  // it (or the old amountToAdjust) is working from a stale mental model, so say
  // so rather than silently dropping the value.
  if (data.totalAmount !== undefined || data.amountToAdjust !== undefined) {
    throw new Error(
      "Total amount cannot be set directly. It is derived from the invoice's line items — add or remove a line item instead.",
    );
  }

  // If status is being updated, throw an error as status changes should be handled through specific workflows (e.g., approval, payment) rather than direct updates to ensure proper business logic is followed.
  if (data.status) {
    throw new Error(
      "Status cannot be updated directly. Use the appropriate workflow to change the invoice status.",
    );
  }
  return await monthlyInvoiceRepository.updateMonthlyInvoice(id, data);
};

const approveMonthlyInvoice = async (id, actorUserId) => {
  const existingInvoice =
    await monthlyInvoiceRepository.getMonthlyInvoiceById(id);
  if (!existingInvoice) {
    throw new Error("Monthly invoice not found.");
  }
  assertTransition(existingInvoice.status, "APPROVED");

  const updateData = { status: "APPROVED", approvedAt: new Date() };

  // Call the repository directly — bypasses the updateMonthlyInvoice guard
  // that blocks direct status changes from external callers.
  const approvedInvoice = await monthlyInvoiceRepository.updateMonthlyInvoice(id, updateData);

  // Render and store the invoice document. Deliberately after the status change
  // and outside its failure path: a missing PDF is recoverable by re-rendering,
  // a half-approved invoice is not. Same reasoning as the approval email below.
  try {
    const forPdf = await monthlyInvoiceRepository.getMonthlyInvoiceById(id);
    const key = invoicePdfKey(forPdf);
    await objectStorage.uploadBuffer(key, renderInvoicePdf(forPdf), "application/pdf");
    await monthlyInvoiceRepository.updateMonthlyInvoice(id, { pdfLink: key });
    approvedInvoice.pdfLink = key;
  } catch (pdfError) {
    console.error("Invoice PDF generation failed:", pdfError.message);
  }

  await audit(actorUserId, "INVOICE_APPROVED", {
    invoiceId: id,
    clientId: existingInvoice.clientId,
    totalAmount: Number(existingInvoice.totalAmount),
    lineItemCount: existingInvoice.lineItems?.length ?? 0,
  });

  // US-090: Email the client to notify them their invoice is ready to view
  try {
    const clientEmail = existingInvoice.client?.email;
    if (clientEmail) {
      const portalUrl = `${APP_BASE_URL}/client/invoices`;
      const billingMonth = new Date(existingInvoice.billingPeriod).toLocaleString("en-GB", {
        month: "long",
        year: "numeric",
      });
      const emailContent = invoiceApprovedEmailTemplate({
        companyName: existingInvoice.client?.companyName || "Valued Client",
        billingMonth,
        totalAmount: existingInvoice.totalAmount,
        portalUrl,
      });
      enqueueMail({
        to: clientEmail,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
      });
    }
  } catch (emailError) {
    // Email failure should NOT roll back the approval — log and continue
    console.error("Invoice approval email failed to queue:", emailError.message);
  }

  return approvedInvoice;
};

/**
 * Deletes a draft invoice. Refused once approved — that document has been sent
 * to the client, and the line items reference real dispatched work. The same
 * reasoning as refusing to delete a dispatched shipment.
 */
const deleteMonthlyInvoice = async (id, actorUserId) => {
  const existing = await monthlyInvoiceRepository.getMonthlyInvoiceById(id);
  if (!existing) {
    throw new Error("Monthly invoice not found.");
  }
  if (!isEditable(existing.status)) {
    throw new Error(
      `A ${existing.status} invoice cannot be deleted. Raise a credit against it instead.`,
    );
  }

  const deleted = await monthlyInvoiceRepository.deleteMonthlyInvoice(id);

  await audit(actorUserId, "INVOICE_DELETED", {
    invoiceId: id,
    clientId: existing.clientId,
    totalAmount: Number(existing.totalAmount),
  });

  return deleted;
};

/**
 * APPROVED -> PAID. Records when the money arrived and against what, because
 * that is the first thing anyone asks when a payment is queried.
 */
const markMonthlyInvoicePaid = async (id, { paymentMethod, paymentReference } = {}, actorUserId) => {
  const existing = await monthlyInvoiceRepository.getMonthlyInvoiceById(id);
  if (!existing) {
    throw new Error("Monthly invoice not found.");
  }
  assertTransition(existing.status, "PAID");

  const paid = await monthlyInvoiceRepository.updateMonthlyInvoice(id, {
    status: "PAID",
    paidAt: new Date(),
    paymentMethod: paymentMethod || null,
    paymentReference: paymentReference || null,
  });

  await audit(actorUserId, "INVOICE_PAID", {
    invoiceId: id,
    clientId: existing.clientId,
    totalAmount: Number(existing.totalAmount),
    paymentMethod: paymentMethod || null,
    paymentReference: paymentReference || null,
  });

  return paid;
};

/**
 * Returns the stored PDF key, rendering and storing one if it is missing.
 * Covers invoices approved before this existed, and a lost storage object.
 */
const ensureInvoicePdf = async (id) => {
  const invoice = await monthlyInvoiceRepository.getMonthlyInvoiceById(id);
  if (!invoice) {
    throw new Error("Monthly invoice not found.");
  }

  const key = invoice.pdfLink || invoicePdfKey(invoice);

  if (!invoice.pdfLink || !(await objectStorage.objectExists(key))) {
    await objectStorage.uploadBuffer(key, renderInvoicePdf(invoice), "application/pdf");
    if (invoice.pdfLink !== key) {
      await monthlyInvoiceRepository.updateMonthlyInvoice(id, { pdfLink: key });
    }
  }

  return { key, invoice };
};

module.exports = {
  ensureInvoicePdf,
  createMonthlyInvoice,
  getAllMonthlyInvoices,
  getMonthlyInvoiceById,
  getMonthlyInvoiceByClientIdForMonth,
  getMonthlyInvoiceByField,
  updateMonthlyInvoice,
  approveMonthlyInvoice,
  markMonthlyInvoicePaid,
  deleteMonthlyInvoice,
  // Shared with the line-item logic, which enforces the same DRAFT-only rule.
  INVOICE_TRANSITIONS,
  isEditable,
  assertTransition,
};
