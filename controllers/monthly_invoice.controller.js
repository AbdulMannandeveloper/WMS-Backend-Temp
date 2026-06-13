const monthlyInvoiceLogic = require("../logic/monthly_invoice.logic");
const invoiceLineItemLogic = require("../logic/invoice_line_item.logic");

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
    const invoices = await monthlyInvoiceLogic.getMonthlyInvoiceByField("clientId", clientId);
    res.status(200).json(invoices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getMonthlyInvoiceById = async (req, res) => {
  try {
    const invoice = await monthlyInvoiceLogic.getMonthlyInvoiceById(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found." });
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
    const invoice = await monthlyInvoiceLogic.updateMonthlyInvoice(req.params.id, req.body);
    res.status(200).json(invoice);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const approveMonthlyInvoice = async (req, res) => {
  try {
    const invoice = await monthlyInvoiceLogic.approveMonthlyInvoice(req.params.id);
    res.status(200).json(invoice);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const deleteMonthlyInvoice = async (req, res) => {
  try {
    await monthlyInvoiceLogic.deleteMonthlyInvoice(req.params.id);
    res.status(200).json({ message: "Invoice deleted successfully." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// ─── Line Items ────────────────────────────────────────────────────────────────

const getLineItemsForInvoice = async (req, res) => {
  try {
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
  deleteMonthlyInvoice,
  getLineItemsForInvoice,
  createLineItem,
  deleteLineItem,
};
