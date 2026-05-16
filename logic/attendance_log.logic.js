const attendanceLogRepository = require("../repositories/attendance_log.repository");
const shiftRepository = require("../repositories/shift.repository");
const holidayRepository = require("../repositories/holiday.repository");

const createAttendanceLog = async (logData) => {
  if (!logData.userId || !logData.loginTimestamp) {
    throw new Error("Missing required fields: userId, loginTimestamp");
  }

  // ----------------------------------------- DEFAULT SHIFT ASSIGNMENT LOGIC -----------------------------------------
  const shift = await shiftRepository.getShiftByField("name", "default");
  if (!shift) {
    throw new Error("Shift not found. Please select an existing shift first.");
  }

  // Check if the login timestamp is within the shift's grace period and enter relevant status
  if (
    new Date(logData.loginTimestamp) <=
    new Date(shift.startTime.getTime() + shift.gracePeriodMins * 60000)
  ) {
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

const updateAttendanceLog = async (id, updateData) => {
  return await attendanceLogRepository.updateAttendanceLog(id, updateData);
};

const updateLogoutTimestamp = async (id, logoutTimestamp) => {
  const attendanceLog = await attendanceLogRepository.getAttendanceLogByField(
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
  updateLogoutTimestamp,
  updateAttendanceLog,
  deleteAttendanceLog,
};
