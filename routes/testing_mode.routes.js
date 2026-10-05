// TESTING-ONLY (whole file) — delete it with the rest; see TESTING_RELAXATIONS.md.

const express = require('express');
const testingModeController = require('../controllers/testing_mode.controller');
const { authorizeRoles } = require('../middlewares/authorize');

const router = express.Router();

// Admin-only, as every delete it allows is.
router.get('/', authorizeRoles('admin'), testingModeController.getTestingMode);
router.post('/', authorizeRoles('admin'), testingModeController.turnOnTestingMode);
router.delete('/', authorizeRoles('admin'), testingModeController.turnOffTestingMode);

module.exports = router;
