const monthlyInvoiceRepository = require("../repositories/monthly_invoice.repository");
const invoiceLineItemRepository = require("../repositories/invoice_line_item.repository");

const clientLogic = require("./client.logic");

const createMonthlyInvoice = async (data) => {
  // Check for required fields
  if (!data.clientId) {
    throw new Error("Client ID is required to create a monthly invoice.");
  }

  const client = await clientLogic.getClientById(data.clientId);
  if (!client) {
    throw new Error("Client not found.");
  }

  if (data.totalAmount && data.totalAmount < 0) {
    throw new Error("Total amount cannot be negative.");
  }

  if (!data.billingPeriod) {
    // Default to 1st of the current month if billing period is not provided
    const now = new Date();
    data.billingPeriod = new Date(now.getFullYear(), now.getMonth(), 1);
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
  const billingMonth = new Date(
    billingPeriod.getFullYear(),
    billingPeriod.getMonth(),
    1,
  );

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
  if (data.amountToAdjust) {
    data.totalAmount = existingInvoice.totalAmount + data.amountToAdjust;
    // Validate that the adjusted total amount is not negative
    if (data.totalAmount < 0) {
      throw new Error("Total amount cannot be negative after adjustment.");
    }
    delete data.amountToAdjust; // Remove the amountToAdjust field as it's not part of the actual invoice data model
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

  const data = { status: "APPROVED", approvedAt: new Date() };

  // ----------------------------------------------------------------
  // Logic to set pdfLink and send email notification to client
  // ----------------------------------------------------------------

  return await monthlyInvoiceRepository.updateMonthlyInvoice(id, data);
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
