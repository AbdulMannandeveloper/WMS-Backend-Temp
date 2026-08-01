const express = require('express');
const profitLossController = require('../controllers/profit_loss.controller');
const { authorizeRoles } = require('../middlewares/authorize');

const router = express.Router();

router.get('/summary', authorizeRoles('admin'), profitLossController.getPLSummary);
router.get('/trends', authorizeRoles('admin'), profitLossController.getPLTrends);
router.get('/client-profitability', authorizeRoles('admin'), profitLossController.getClientProfitability);

module.exports = router;
