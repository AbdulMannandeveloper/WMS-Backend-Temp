const express = require("express");
const { authorizeRoles } = require("../middlewares/authorize");
const {
  createService,
  getAllServices,
  getServiceById,
  updateService,
  deleteService,
} = require("../controllers/service.controller");

const router = express.Router();

router.post("/", authorizeRoles('admin'), createService);
router.get("/", authorizeRoles('admin'), getAllServices);
router.get("/:id", authorizeRoles('admin'), getServiceById);
router.put("/:id", authorizeRoles('admin'), updateService);
router.delete("/:id", authorizeRoles('admin'), deleteService);

module.exports = router;
