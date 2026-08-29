const monthlyInvoiceLogic = require("../logic/monthly_invoice.logic");
const invoiceLineItemLogic = require("../logic/invoice_line_item.logic");
const { resolveOwnClientId, canAccessClientId } = require("../utils/clientScope");
const { pick } = require("../utils/pick");

// totalAmount is deliberately absent: it is derived from the invoice's line
// items. status is absent too — it moves through the approval workflow only.
const INVOICE_UPDATE_FIELDS = ["billingPeriod", "pdfLink"];

// paidAt is stamped server-side; only the human-supplied details come from the body.
const PAYMENT_FIELDS = ["paymentMethod", "paymentReference"];

const getAllMonthlyInvoices = async (req, res) => {
  try {
    const invoices = await monthlyInvoiceLogic.getAllMonthlyInvoices();
    res.status(200).json(invoices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getMonthlyInvoicesByClient = async (req, res) => {
  try {
    const { clientId } = req.params;

    // A client may only read their own invoices. Admins may read any.
    if (!(await canAccessClientId(req.user, clientId))) {
      return res.status(403).json({ error: "You do not have access to this client's records." });
    }

    const invoices = await monthlyInvoiceLogic.getMonthlyInvoiceByField("clientId", clientId);
    res.status(200).json(invoices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getMonthlyInvoiceById = async (req, res) => {
  try {
    const ownClientId = await resolveOwnClientId(req.user);
    const invoice = await monthlyInvoiceLogic.getMonthlyInvoiceById(req.params.id);
    // 404 rather than 403 for a foreign invoice, so a client cannot probe which
    // invoice ids exist outside their own account.
    if (!invoice || (ownClientId && invoice.clientId !== ownClientId)) {
      return res.status(404).json({ error: "Invoice not found." });
    }
    res.status(200).json(invoice);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const createMonthlyInvoice = async (req, res) => {
  try {
    const invoice = await monthlyInvoiceLogic.createMonthlyInvoice(req.body);
    res.status(201).json(invoice);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const updateMonthlyInvoice = async (req, res) => {
  try {
    const invoice = await monthlyInvoiceLogic.updateMonthlyInvoice(
      req.params.id,
      pick(req.body, INVOICE_UPDATE_FIELDS),
    );
    res.status(200).json(invoice);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const approveMonthlyInvoice = async (req, res) => {
  try {
    const invoice = await monthlyInvoiceLogic.approveMonthlyInvoice(
      req.params.id,
      req.user.id,
    );
    res.status(200).json(invoice);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const markMonthlyInvoicePaid = async (req, res) => {
  try {
    const invoice = await monthlyInvoiceLogic.markMonthlyInvoicePaid(
      req.params.id,
      pick(req.body, PAYMENT_FIELDS),
      req.user.id,
    );
    res.status(200).json(invoice);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const deleteMonthlyInvoice = async (req, res) => {
  try {
    await monthlyInvoiceLogic.deleteMonthlyInvoice(req.params.id, req.user.id);
    res.status(200).json({ message: "Invoice deleted successfully." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// ─── Line Items ────────────────────────────────────────────────────────────────

const getLineItemsForInvoice = async (req, res) => {
  try {
    const ownClientId = await resolveOwnClientId(req.user);
    if (ownClientId) {
      // Line items are only reachable through an invoice the caller owns.
      const invoice = await monthlyInvoiceLogic.getMonthlyInvoiceById(req.params.id);
      if (!invoice || invoice.clientId !== ownClientId) {
        return res.status(404).json({ error: "Invoice not found." });
      }
    }
    const items = await invoiceLineItemLogic.getInvoiceLineItemsByField("invoiceId", req.params.id);
    res.status(200).json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const createLineItem = async (req, res) => {
  try {
    const item = await invoiceLineItemLogic.createInvoiceLineItem({
      ...req.body,
      invoiceId: req.params.id,
      itemType: "MANUAL_CHARGE",
    });
    res.status(201).json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const deleteLineItem = async (req, res) => {
  try {
    await invoiceLineItemLogic.deleteInvoiceLineItem(req.params.lineItemId);
    res.status(200).json({ message: "Line item removed." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

module.exports = {
  getAllMonthlyInvoices,
  getMonthlyInvoicesByClient,
  getMonthlyInvoiceById,
  createMonthlyInvoice,
  updateMonthlyInvoice,
  approveMonthlyInvoice,
  markMonthlyInvoicePaid,
  deleteMonthlyInvoice,
  getLineItemsForInvoice,
  createLineItem,
  deleteLineItem,
};
