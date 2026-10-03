const express = require("express");
const { authorizeRoles } = require("../middlewares/authorize");
const {
  createService,
  getAllServices,
  getServiceById,
  updateService,
  getServiceDependents,
  deleteService,
  setServiceActive,
} = require("../controllers/service.controller");

const router = express.Router();

router.post("/", authorizeRoles('admin'), createService);
router.get("/", authorizeRoles('admin'), getAllServices);
router.get("/:id", authorizeRoles('admin'), getServiceById);
router.put("/:id", authorizeRoles('admin'), updateService);

// Deleting is refused while shipments still carry the service; /dependents
// says which, so the admin sees it before pressing delete.
router.get("/:id/dependents", authorizeRoles('admin'), getServiceDependents);
router.delete("/:id", authorizeRoles('admin'), deleteService);
// The way out for one in use, which cannot be deleted. Admin-only, as delete is.
router.patch("/:id/active", authorizeRoles('admin'), setServiceActive);

module.exports = router;
