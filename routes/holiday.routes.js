const holidayController = require('../controllers/holiday.controller');
const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const router = express.Router();

router.post('/', authorizeRoles('admin'), holidayController.createHoliday);
router.get('/', authorizeRoles('admin'), holidayController.getAllHolidays);
router.get('/:id', authorizeRoles('admin'), holidayController.getHolidayById);
router.put('/:id', authorizeRoles('admin'), holidayController.updateHoliday);
router.delete('/:id', authorizeRoles('admin'), holidayController.deleteHoliday);

module.exports = router;