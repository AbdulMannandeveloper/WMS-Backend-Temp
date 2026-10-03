const shiftController = require('../controllers/shift.controller');
const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const router = express.Router();

router.post('/', authorizeRoles('admin'), shiftController.createShift);
router.get('/', authorizeRoles('admin'), shiftController.getAllShifts);
router.get('/:id', authorizeRoles('admin'), shiftController.getShiftById);
router.put('/:id', authorizeRoles('admin'), shiftController.updateShift);
// What a delete would refuse on — the same gate as the delete it describes.
router.get('/:id/dependents', authorizeRoles('admin'), shiftController.getShiftDependents);
router.delete('/:id', authorizeRoles('admin'), shiftController.deleteShift);

module.exports = router;