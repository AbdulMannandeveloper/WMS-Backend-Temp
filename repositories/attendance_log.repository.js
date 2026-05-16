const { prisma } = require("../lib/prisma");

const prismaAttendanceLog = prisma.attendanceLog;

const createAttendanceLog = async (logData) => {
  return await prismaAttendanceLog.create({ data: logData });
};

const getAllAttendanceLogs = async () => {
  return await prismaAttendanceLog.findMany();
};

const getAttendanceLogByField = async (field, value) => {
  return await prismaAttendanceLog.findUnique({ where: { [field]: value } });
};

const updateAttendanceLog = async (id, updateData) => {
  return await prismaAttendanceLog.update({ where: { id }, data: updateData });
};

const deleteAttendanceLog = async (id) => {
  return await prismaAttendanceLog.delete({ where: { id } });
};

module.exports = {
  createAttendanceLog,
  getAllAttendanceLogs,
  getAttendanceLogByField,
  updateAttendanceLog,
  deleteAttendanceLog,
};
