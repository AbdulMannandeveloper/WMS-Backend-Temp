const attendanceController = require("../controllers/attendance.controller");
const express = require("express");
const { authorizeRoles } = require("../middlewares/authorize");
const router = express.Router();

// Specific named routes MUST come before wildcard /:field/:value
// US-068/069: Admin-triggered archive: archive monthly summaries + purge logs older than 2 months
router.post("/archive-and-cleanup", authorizeRoles("admin"), attendanceController.archiveAndCleanup);

router.post("/", authorizeRoles("admin", "employee"), attendanceController.createAttendanceLog);
router.get("/", authorizeRoles("admin"), attendanceController.getAllAttendanceLogs);
router.get("/:field/:value", authorizeRoles("admin", "employee"), attendanceController.getAttendanceLogByField);
router.put("/:id", authorizeRoles("admin"), attendanceController.updateAttendanceLog);
router.put("/:id/logout", authorizeRoles("admin", "employee"), attendanceController.updateLogoutTimestamp);
router.delete("/:id", authorizeRoles("admin"), attendanceController.deleteAttendanceLog);

module.exports = router;
