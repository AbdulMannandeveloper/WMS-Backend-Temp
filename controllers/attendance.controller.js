const attendanceLogLogic = require('../logic/attendance_log.logic');
const { pick } = require('../utils/pick');
const { parsePagination, paginatedResponse } = require('../utils/pagination');

const ATTENDANCE_UPDATE_FIELDS = ['status', 'loginTimestamp', 'logoutTimestamp', 'date'];

const createAttendanceLog = async (req, res) => {
  try {
    // Employees can only log attendance for themselves; admins may log for anyone.
    const userId = req.user.role === "admin" && req.body.userId ? req.body.userId : req.user.id;
    const payload = {
      userId,
      loginTimestamp: req.body.loginTimestamp,
      logoutTimestamp: req.body.logoutTimestamp,
      status: req.body.status,
      date: req.body.date,
    };
    const attendanceLog = await attendanceLogLogic.createAttendanceLog(payload);
    res.status(201).json(attendanceLog);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getAllAttendanceLogs = async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const result = await attendanceLogLogic.getAllAttendanceLogs(pagination);
    if (result && result.items) {
      return res.status(200).json(
        paginatedResponse(result.items, result.total, pagination),
      );
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getAttendanceLogByField = async (req, res) => {
  try {
    let { field, value } = req.params;
    // Employees may only read their own attendance, regardless of the params they send.
    if (req.user.role !== "admin") {
      field = "userId";
      value = req.user.id;
    }
    const attendanceLog = await attendanceLogLogic.getAttendanceLogByField(field, value);
    res.status(200).json(attendanceLog);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
};

const updateAttendanceLog = async (req, res) => {
  try {
    const attendanceLog = await attendanceLogLogic.updateAttendanceLog(req.params.id, pick(req.body, ATTENDANCE_UPDATE_FIELDS));
    res.status(200).json(attendanceLog);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const updateLogoutTimestamp = async (req, res) => {
  try {
    // Employees may only update their own attendance record.
    if (req.user.role !== "admin") {
      const logs = await attendanceLogLogic.getAttendanceLogByField("id", req.params.id);
      const target = Array.isArray(logs) ? logs[0] : logs;
      if (!target || target.userId !== req.user.id) {
        return res.status(403).json({ error: "You can only update your own attendance record." });
      }
    }
    const attendanceLog = await attendanceLogLogic.updateLogoutTimestamp(req.params.id, req.body.logoutTimestamp);
    res.status(200).json(attendanceLog);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const deleteAttendanceLog = async (req, res) => {
  try {
    const attendanceLog = await attendanceLogLogic.deleteAttendanceLog(req.params.id);
    res.status(200).json(attendanceLog);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// US-068/069: Admin-triggered archive and cleanup of attendance logs older than 2 months
const archiveAndCleanup = async (req, res) => {
  try {
    const result = await attendanceLogLogic.archiveAndCleanupOldLogs();
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const markLeave = async (req, res) => {
  try {
    const attendanceLog = await attendanceLogLogic.markLeave(req.body);
    res.status(200).json(attendanceLog);
  } catch (error) {
    const status = error.message.includes("already exists") ? 409 : 400;
    res.status(status).json({ error: error.message });
  }
};

const unmarkLeave = async (req, res) => {
  try {
    const attendanceLog = await attendanceLogLogic.unmarkLeave(req.body);
    res.status(200).json(attendanceLog);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getEmployeeAttendanceAnalytics = async (req, res) => {
  try {
    const analytics = await attendanceLogLogic.getEmployeeAttendanceAnalytics(req.params.userId, {
      year: req.query.year,
      month: req.query.month,
    });
    res.status(200).json(analytics);
  } catch (error) {
    const status = error.message === 'User not found' ? 404 : 400;
    res.status(status).json({ error: error.message });
  }
};

module.exports = {
  createAttendanceLog,
  getAllAttendanceLogs,
  getAttendanceLogByField,
  updateAttendanceLog,
  updateLogoutTimestamp,
  deleteAttendanceLog,
  archiveAndCleanup,
  markLeave,
  unmarkLeave,
  getEmployeeAttendanceAnalytics,
};