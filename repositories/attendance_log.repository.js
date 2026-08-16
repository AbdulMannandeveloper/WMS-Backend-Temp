const { prisma } = require("../lib/prisma");
const { assertAllowedField } = require("../utils/pick");

const prismaAttendanceLog = prisma.employeeAttendanceLog;

const ATTENDANCE_QUERY_FIELDS = ["id", "userId", "status", "date"];

const createAttendanceLog = async (logData) => {
  return await prismaAttendanceLog.create({ data: logData });
};

const getAllAttendanceLogs = async (pagination) => {
  if (pagination && pagination.take != null) {
    const [items, total] = await Promise.all([
      prismaAttendanceLog.findMany({
        skip: pagination.skip || 0,
        take: pagination.take,
        orderBy: { date: "desc" },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              username: true,
              email: true,
            },
          },
        },
      }),
      prismaAttendanceLog.count(),
    ]);
    return { items, total };
  }

  return await prismaAttendanceLog.findMany({
    orderBy: { date: "desc" },
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          username: true,
          email: true,
        },
      },
    },
  });
};

const getAttendanceLogByField = async (field, value) => {
  assertAllowedField(field, ATTENDANCE_QUERY_FIELDS);
  return await prismaAttendanceLog.findMany({ where: { [field]: value } });
};

const getAttendanceLogFirstByField = async (field, value) => {
  assertAllowedField(field, ATTENDANCE_QUERY_FIELDS);
  return await prismaAttendanceLog.findFirst({ where: { [field]: value } });
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
  getAttendanceLogFirstByField,
  updateAttendanceLog,
  deleteAttendanceLog,
};
