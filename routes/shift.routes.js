const shiftController = require('../controllers/shift.controller');
const express = require('express');
const router = express.Router();

router.post('/', shiftController.createShift);
router.get('/', shiftController.getAllShifts);
router.get('/:id', shiftController.getShiftById);
router.put('/:id', shiftController.updateShift);
router.delete('/:id', shiftController.deleteShift);

module.exports = router;