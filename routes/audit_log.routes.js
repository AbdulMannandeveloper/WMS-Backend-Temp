const express = require('express');
const auditLogController = require('../controllers/audit_log.controller');
const { authorizeRoles } = require('../middlewares/authorize');

const router = express.Router();

// /summary before any wildcard. This router has none today, but every other
// one in this codebase does, and a /summary mounted below a /:id is caught by
// it and answers as a lookup for an invoice with the id "summary".
router.get('/summary', authorizeRoles('admin'), auditLogController.getAuditLogSummary);
router.get('/', authorizeRoles('admin'), auditLogController.getAllAuditLogs);

module.exports = router;
