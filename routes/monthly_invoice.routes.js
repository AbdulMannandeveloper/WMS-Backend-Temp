const express = require("express");
const router = express.Router();
const invoiceController = require("../controllers/monthly_invoice.controller");
const { authorizeRoles } = require("../middlewares/authorize");

const adminOnly = authorizeRoles("admin");

// Clients read their own billing history in the portal. Ownership of :clientId /
// :id is verified in the controller, which 404s anything outside their account.
const adminOrClient = authorizeRoles("admin", "client");

// Client-readable reads
router.get("/client/:clientId", adminOrClient, invoiceController.getMonthlyInvoicesByClient);
router.get("/:id", adminOrClient, invoiceController.getMonthlyInvoiceById);
router.get("/:id/line-items", adminOrClient, invoiceController.getLineItemsForInvoice);

// Invoice CRUD (admin only)
router.get("/", adminOnly, invoiceController.getAllMonthlyInvoices);
router.post("/", adminOnly, invoiceController.createMonthlyInvoice);
router.put("/:id", adminOnly, invoiceController.updateMonthlyInvoice);
router.post("/:id/approve", adminOnly, invoiceController.approveMonthlyInvoice);
router.post("/:id/pay", adminOnly, invoiceController.markMonthlyInvoicePaid);
router.delete("/:id", adminOnly, invoiceController.deleteMonthlyInvoice);

// Line Items (nested under invoice, admin only)
router.post("/:id/line-items", adminOnly, invoiceController.createLineItem);
router.delete("/:id/line-items/:lineItemId", adminOnly, invoiceController.deleteLineItem);

module.exports = router;
