const express = require("express");
const router = express.Router();
const invoiceController = require("../controllers/monthly_invoice.controller");
const { authorizeRoles } = require("../middlewares/authorize");

const adminOnly = authorizeRoles("admin");

// Clients read their own billing history in the portal. Ownership of :clientId /
// :id is verified in the controller, which 404s anything outside their account.
const adminOrClient = authorizeRoles("admin", "client");

// The platform tax rate. Staff may read it so the invoices screen can show what
// would be added; only an admin changes it.
//
// MUST stay above the "/:id" routes below. Express matches in declaration order,
// so declared after them, GET /tax-rate is captured by GET /:id and looked up as
// an invoice whose id is the literal string "tax-rate".
router.get("/tax-rate", authorizeRoles("admin", "employee"), invoiceController.getTaxRate);
router.put("/tax-rate", adminOnly, invoiceController.updateTaxRate);

// Client-readable reads
router.get("/client/:clientId", adminOrClient, invoiceController.getMonthlyInvoicesByClient);
router.get("/:id", adminOrClient, invoiceController.getMonthlyInvoiceById);
router.get("/:id/line-items", adminOrClient, invoiceController.getLineItemsForInvoice);
router.get("/:id/pdf", adminOrClient, invoiceController.getMonthlyInvoicePdf);

// Invoice CRUD (admin only)
router.get("/", adminOnly, invoiceController.getAllMonthlyInvoices);
router.post("/", adminOnly, invoiceController.createMonthlyInvoice);
router.put("/:id", adminOnly, invoiceController.updateMonthlyInvoice);
// Tax on one invoice, while it is still DRAFT.
router.post("/:id/tax", adminOnly, invoiceController.setTax);

router.post("/:id/approve", adminOnly, invoiceController.approveMonthlyInvoice);
router.post("/:id/pay", adminOnly, invoiceController.markMonthlyInvoicePaid);
router.delete("/:id", adminOnly, invoiceController.deleteMonthlyInvoice);

// Line Items (nested under invoice, admin only)
router.post("/:id/line-items", adminOnly, invoiceController.createLineItem);

// Charging a quantity of a service a client has already agreed a rate for, onto
// whichever period is open. Declared before nothing in particular, but note it
// is a collection route rather than /:id/ — the invoice is resolved, not chosen.
router.delete("/:id/line-items/:lineItemId", adminOnly, invoiceController.deleteLineItem);
router.post("/charge-service", adminOnly, invoiceController.chargeService);

module.exports = router;
