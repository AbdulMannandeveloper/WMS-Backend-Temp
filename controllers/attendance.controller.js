const attendanceLogLogic = require('../logic/attendance_log.logic');

const createAttendanceLog = async (req, res) => {
  try {
    const attendanceLog = await attendanceLogLogic.createAttendanceLog(req.body);
    res.status(201).json(attendanceLog);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getAllAttendanceLogs = async (req, res) => {
  try {
    const attendanceLogs = await attendanceLogLogic.getAllAttendanceLogs();
    res.status(200).json(attendanceLogs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getAttendanceLogByField = async (req, res) => {
  try {
    const attendanceLog = await attendanceLogLogic.getAttendanceLogByField(req.params.field, req.params.value);
    res.status(200).json(attendanceLog);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
};

const updateAttendanceLog = async (req, res) => {
  try {
    const attendanceLog = await attendanceLogLogic.updateAttendanceLog(req.params.id, req.body);
    res.status(200).json(attendanceLog);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const updateLogoutTimestamp = async (req, res) => {
  try {
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

module.exports = {
  createAttendanceLog,
  getAllAttendanceLogs,
  getAttendanceLogByField,
  updateAttendanceLog,
  updateLogoutTimestamp,
  deleteAttendanceLog
};