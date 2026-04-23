const express = require('express');
const { createService, getAllServices } = require('../controllers/service.controller');

const router = express.Router();

router.post('/', createService);
router.get('/', getAllServices);

module.exports = router;