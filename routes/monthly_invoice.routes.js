const express = require("express");
const router = express.Router();
const invoiceController = require("../controllers/monthly_invoice.controller");
const { authorizeRoles } = require("../middlewares/authorize");

// Apply admin authorization to all invoice routes
router.use(authorizeRoles("admin"));

// Invoice CRUD
router.get("/", invoiceController.getAllMonthlyInvoices);
router.get("/client/:clientId", invoiceController.getMonthlyInvoicesByClient);
router.get("/:id", invoiceController.getMonthlyInvoiceById);
router.post("/", invoiceController.createMonthlyInvoice);
router.put("/:id", invoiceController.updateMonthlyInvoice);
router.post("/:id/approve", invoiceController.approveMonthlyInvoice);
router.delete("/:id", invoiceController.deleteMonthlyInvoice);

// Line Items (nested under invoice)
router.get("/:id/line-items", invoiceController.getLineItemsForInvoice);
router.post("/:id/line-items", invoiceController.createLineItem);
router.delete("/:id/line-items/:lineItemId", invoiceController.deleteLineItem);

module.exports = router;
