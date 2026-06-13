const attendanceLogRepository = require("../repositories/attendance_log.repository");
const shiftRepository = require("../repositories/shift.repository");
const holidayRepository = require("../repositories/holiday.repository");

const createAttendanceLog = async (logData) => {
  if (!logData.userId || !logData.loginTimestamp) {
    throw new Error("Missing required fields: userId, loginTimestamp");
  }

  // ----------------------------------------- DEFAULT SHIFT ASSIGNMENT LOGIC -----------------------------------------
  const shift = await shiftRepository.getShiftFirstByField("name", "default");
  if (!shift) {
    throw new Error("Shift not found. Please select an existing shift first.");
  }

  // Check if the login timestamp is within the shift's grace period and enter relevant status
  const loginDate = new Date(logData.loginTimestamp);
  const loginMinutes = loginDate.getUTCHours() * 60 + loginDate.getUTCMinutes();

  const shiftStart = new Date(shift.startTime);
  const shiftMinutes = shiftStart.getUTCHours() * 60 + shiftStart.getUTCMinutes();

  if (loginMinutes <= shiftMinutes + shift.gracePeriodMins) {
    logData.status = "on-time";
  } else {
    logData.status = "late";
  }

  return await attendanceLogRepository.createAttendanceLog(logData);
};

const getAllAttendanceLogs = async () => {
  return await attendanceLogRepository.getAllAttendanceLogs();
};

const getAttendanceLogByUserId = async (id) => {
  return await attendanceLogRepository.getAttendanceLogByField("userId", id);
};

const getAttendanceLogByField = async (field, value) => {
  return await attendanceLogRepository.getAttendanceLogByField(field, value);
};

const updateAttendanceLog = async (id, updateData) => {
  return await attendanceLogRepository.updateAttendanceLog(id, updateData);
};

const updateLogoutTimestamp = async (id, logoutTimestamp) => {
  const attendanceLog = await attendanceLogRepository.getAttendanceLogFirstByField(
    "id",
    id,
  );
  if (!attendanceLog) {
    throw new Error("Attendance log not found");
  } else {
    // Check if the logout timestamp is before the login timestamp
    if (new Date(logoutTimestamp) < new Date(attendanceLog.loginTimestamp)) {
      throw new Error("Logout timestamp cannot be before login timestamp");
    }
  }

  return await attendanceLogRepository.updateAttendanceLog(id, {
    logoutTimestamp,
  });
};

const deleteAttendanceLog = async (id) => {
  return await attendanceLogRepository.deleteAttendanceLog(id);
};

module.exports = {
  createAttendanceLog,
  getAllAttendanceLogs,
  getAttendanceLogByUserId,
  getAttendanceLogByField,
  updateLogoutTimestamp,
  updateAttendanceLog,
  deleteAttendanceLog,
};
