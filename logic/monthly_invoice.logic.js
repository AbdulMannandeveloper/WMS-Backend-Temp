const monthlyInvoiceRepository = require("../repositories/monthly_invoice.repository");
const invoiceLineItemRepository = require("../repositories/invoice_line_item.repository");

const clientLogic = require("./client.logic");
const { firstOfMonthUtc } = require("../utils/dates");
const { enqueueMail } = require("../utils/mailQueue");
const { invoiceApprovedEmailTemplate } = require("../utils/emailTemplates");

const APP_BASE_URL = process.env.APP_BASE_URL || "https://myapp.com";

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

const approveMonthlyInvoice = async (id) => {
  const existingInvoice =
    await monthlyInvoiceRepository.getMonthlyInvoiceById(id);
  if (!existingInvoice) {
    throw new Error("Monthly invoice not found.");
  }
  if (existingInvoice.status !== "DRAFT") {
    throw new Error("Only invoices in DRAFT status can be approved.");
  }

  const updateData = { status: "APPROVED", approvedAt: new Date() };

  // Call the repository directly — bypasses the updateMonthlyInvoice guard
  // that blocks direct status changes from external callers.
  const approvedInvoice = await monthlyInvoiceRepository.updateMonthlyInvoice(id, updateData);

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

const deleteMonthlyInvoice = async (id) => {
  return await monthlyInvoiceRepository.deleteMonthlyInvoice(id);
};

module.exports = {
  createMonthlyInvoice,
  getAllMonthlyInvoices,
  getMonthlyInvoiceById,
  getMonthlyInvoiceByClientIdForMonth,
  getMonthlyInvoiceByField,
  updateMonthlyInvoice,
  approveMonthlyInvoice,
  deleteMonthlyInvoice,
};
