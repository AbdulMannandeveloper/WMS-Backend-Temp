const { prisma } = require("../lib/prisma");
const monthlyInvoiceRepository = require("../repositories/monthly_invoice.repository");
const invoiceLineItemRepository = require("../repositories/invoice_line_item.repository");

const clientLogic = require("./client.logic");
const { firstOfMonthUtc } = require("../utils/dates");
const { enqueueMail } = require("../utils/mailQueue");
const {
  invoiceApprovedEmailTemplate,
  invoiceUpdatedEmailTemplate,
} = require("../utils/emailTemplates");

const auditLogLogic = require("./audit_log.logic");
const { getTaxRate, taxOn } = require("./settings.logic");
const { renderInvoicePdf, invoicePdfKey } = require("../utils/invoicePdf");
// Held as a module rather than destructured: the storage functions are called
// through it so the failure path stays reachable from a test.
const objectStorage = require("../lib/objectStorage");

const APP_BASE_URL = process.env.APP_BASE_URL || "https://myapp.com";

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

/**
 * The invoice lifecycle, stated in one place the way SHIPMENT_TRANSITIONS is in
 * shipment.logic.js.
 *
 * PAID is terminal. An APPROVED invoice has already been sent, so it is never
 * deleted outright — see isEditable — but an admin may still correct its line
 * items and tax; see isLineItemEditable and syncApprovedInvoicePdf.
 */
const INVOICE_TRANSITIONS = {
  DRAFT: ["APPROVED"],
  APPROVED: ["PAID"],
  PAID: [],
};

/** Only a DRAFT invoice accepts deletion — an APPROVED one is credited instead. */
const isEditable = (status) => status === "DRAFT";

/**
 * DRAFT or APPROVED accept line-item and tax changes; PAID is frozen — money
 * has already changed hands against that total. Admin editing an APPROVED
 * invoice is the one case where a change lands on a document already sent to
 * the client, which is why every caller of this also runs the invoice back
 * through syncApprovedInvoicePdf below.
 */
const isLineItemEditable = (status) => status === "DRAFT" || status === "APPROVED";

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

/**
 * Applies or removes tax on an invoice.
 *
 * DRAFT or APPROVED — an admin may still correct an approved invoice's tax,
 * same as a line item. That edit lands on a document the client may already
 * have, so the caller re-renders and re-notifies via syncApprovedInvoicePdf.
 *
 * The platform rate is snapshotted onto the invoice at the moment tax is applied
 * rather than read live when the invoice is rendered. Otherwise changing the
 * rate next April would silently restate every invoice ever issued.
 */
const setInvoiceTax = async (id, applied, actorUserId) => {
  const invoice = await monthlyInvoiceRepository.getMonthlyInvoiceById(id);
  if (!invoice) {
    throw new Error("Monthly invoice not found.");
  }

  if (!isLineItemEditable(invoice.status)) {
    throw new Error(
      `Tax can only be changed while an invoice is DRAFT or APPROVED — this one is ${invoice.status}.`,
    );
  }

  const wantTax = Boolean(applied);
  const rate = wantTax ? await getTaxRate() : null;
  const subtotal = Number(invoice.totalAmount ?? 0);

  const updated = await monthlyInvoiceRepository.updateMonthlyInvoice(id, {
    taxApplied: wantTax,
    // Kept when removing tax so the invoice still records the rate it was
    // briefly issued at; taxAmount going to zero is what stops it being charged.
    taxRate: wantTax ? rate : invoice.taxRate,
    taxAmount: wantTax ? taxOn(subtotal, rate) : 0,
  });

  await auditLogLogic
    .createAuditLog(actorUserId, wantTax ? "INVOICE_TAX_APPLIED" : "INVOICE_TAX_REMOVED", {
      invoiceId: id,
      rate: wantTax ? rate : null,
      subtotal,
      taxAmount: wantTax ? taxOn(subtotal, rate) : 0,
    })
    .catch((err) => console.error("Audit log error:", err.message));

  await syncApprovedInvoicePdf(id);

  return updated;
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
 * Re-renders and re-uploads the PDF for an invoice, and tells the client it
 * changed. A no-op for DRAFT (no PDF exists yet, nothing has been sent) and
 * for PAID (frozen, and line items/tax can no longer reach this point). Called
 * after every line-item or tax edit so an APPROVED invoice's stored PDF never
 * disagrees with what is on screen.
 *
 * Failures here are logged rather than thrown: the edit that triggered this
 * already succeeded and committed, and a stale PDF is recoverable the same way
 * a missing one is in ensureInvoicePdf — by re-rendering.
 */
const syncApprovedInvoicePdf = async (id) => {
  const invoice = await monthlyInvoiceRepository.getMonthlyInvoiceById(id);
  if (!invoice || invoice.status !== "APPROVED") {
    return;
  }

  try {
    const key = invoice.pdfLink || invoicePdfKey(invoice);
    await objectStorage.uploadBuffer(key, renderInvoicePdf(invoice), "application/pdf");
    if (invoice.pdfLink !== key) {
      await monthlyInvoiceRepository.updateMonthlyInvoice(id, { pdfLink: key });
    }
  } catch (pdfError) {
    console.error("Invoice PDF regeneration failed:", pdfError.message);
    return;
  }

  try {
    const clientEmail = invoice.client?.email;
    if (clientEmail) {
      const portalUrl = `${APP_BASE_URL}/client/invoices`;
      const billingMonth = new Date(invoice.billingPeriod).toLocaleString("en-GB", {
        month: "long",
        year: "numeric",
      });
      const emailContent = invoiceUpdatedEmailTemplate({
        companyName: invoice.client?.companyName || "Valued Client",
        billingMonth,
        totalAmount: invoice.totalAmount,
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
    console.error("Invoice update email failed to queue:", emailError.message);
  }
};

/**
 * Applies a batch of line-item additions/removals and an optional tax change
 * to a DRAFT or APPROVED invoice in one transaction, then syncs the PDF and
 * client notification exactly once.
 *
 * This exists so the admin "edit invoice" screen can stage several changes —
 * remove a line, add two more, flip tax on — and commit them as a single act.
 * Routing each through createInvoiceLineItem/deleteInvoiceLineItem/setInvoiceTax
 * individually would still work, but each of those syncs the PDF and re-emails
 * the client on its own, so five staged edits would mean five emails.
 */
const applyInvoiceEdits = async (
  id,
  { addLineItems = [], removeLineItemIds = [], taxApplied } = {},
  actorUserId,
) => {
  const hasLineItemChanges = addLineItems.length > 0 || removeLineItemIds.length > 0;
  const changesTax = taxApplied === true || taxApplied === false;
  if (!hasLineItemChanges && !changesTax) {
    throw new Error("No changes were supplied.");
  }

  // Read before the transaction, same as setInvoiceTax — a rate that moves
  // mid-flight is no different from one read a second earlier.
  const rate = changesTax && taxApplied ? await getTaxRate() : null;

  await prisma.$transaction(async (tx) => {
    const invoice = await monthlyInvoiceRepository.getMonthlyInvoiceById(id, tx);
    if (!invoice) {
      throw new Error("Monthly invoice not found.");
    }
    if (!isLineItemEditable(invoice.status)) {
      throw new Error(
        `This invoice is ${invoice.status} and can no longer be changed. Raise a credit or a new charge against a draft instead.`,
      );
    }

    for (const lineItemId of removeLineItemIds) {
      const existing = await invoiceLineItemRepository.getInvoiceLineItemsByField("id", lineItemId, tx);
      const item = Array.isArray(existing) ? existing[0] : existing;
      if (!item || item.invoiceId !== id) {
        throw new Error("One of the line items to remove was not found on this invoice.");
      }
      await invoiceLineItemRepository.deleteInvoiceLineItem(lineItemId, tx);
    }

    for (const raw of addLineItems) {
      if (!raw || !raw.quantity || !raw.unitPrice) {
        throw new Error("Each new line item needs a quantity and unit price.");
      }
      if (raw.quantity <= 0) {
        throw new Error("Quantity must be greater than zero.");
      }
      if (raw.unitPrice < 0) {
        throw new Error("Unit price cannot be negative.");
      }
      await invoiceLineItemRepository.createInvoiceLineItem(
        {
          description: raw.description || "No description provided",
          quantity: raw.quantity,
          unitPrice: raw.unitPrice,
          dateOfService: raw.dateOfService ? new Date(raw.dateOfService) : new Date(),
          invoiceId: id,
          itemType: "MANUAL_CHARGE",
          totalPrice: Number(raw.quantity) * Number(raw.unitPrice),
        },
        tx,
      );
    }

    if (changesTax) {
      await monthlyInvoiceRepository.updateMonthlyInvoice(
        id,
        {
          taxApplied,
          // Kept when removing tax so the invoice still records the rate it
          // was briefly issued at — same as setInvoiceTax.
          taxRate: taxApplied ? rate : invoice.taxRate,
        },
        tx,
      );
    }

    // Re-derives totalAmount from the line items, and — since taxApplied/
    // taxRate above are already whatever this edit wants them to be —
    // taxAmount along with it. One write instead of duplicating the tax
    // formula here.
    await monthlyInvoiceRepository.recalculateInvoiceTotal(id, tx);
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, "INVOICE_EDITED", {
    invoiceId: id,
    lineItemsAdded: addLineItems.length,
    lineItemsRemoved: removeLineItemIds.length,
    taxChanged: changesTax,
  });

  await syncApprovedInvoicePdf(id);

  return await monthlyInvoiceRepository.getMonthlyInvoiceById(id);
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
  setInvoiceTax,
  applyInvoiceEdits,
  approveMonthlyInvoice,
  markMonthlyInvoicePaid,
  deleteMonthlyInvoice,
  syncApprovedInvoicePdf,
  // Shared with the line-item logic, which enforces the same editability rule.
  INVOICE_TRANSITIONS,
  isEditable,
  isLineItemEditable,
  assertTransition,
};
