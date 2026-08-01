const express = require('express');
const auditLogController = require('../controllers/audit_log.controller');
const { authorizeRoles } = require('../middlewares/authorize');

const router = express.Router();

router.get('/', authorizeRoles('admin'), auditLogController.getAllAuditLogs);

module.exports = router;
