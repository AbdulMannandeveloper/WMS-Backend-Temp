const { prisma } = require("../lib/prisma");
const { assertAllowedField } = require("../utils/pick");

const prismaAttendanceLog = prisma.employeeAttendanceLog;

const ATTENDANCE_QUERY_FIELDS = ["id", "userId", "status", "date"];

const createAttendanceLog = async (logData) => {
  return await prismaAttendanceLog.create({ data: logData });
};

// A person, named — never the whole User row, which carries passwordHash.
const userSummary = {
  select: {
    id: true,
    firstName: true,
    lastName: true,
    username: true,
    email: true,
  },
};

/**
 * @param {object} filters - a Prisma `where`; {} matches everything.
 * @param {object} [pagination] - { skip, take }. Absent, the whole set comes
 *   back as a bare array for internal callers.
 */
const getAllAttendanceLogs = async (filters = {}, pagination) => {
  const where = filters;

  if (pagination && pagination.take != null) {
    const [items, total] = await Promise.all([
      prismaAttendanceLog.findMany({
        where,
        skip: pagination.skip || 0,
        take: pagination.take,
        orderBy: { date: "desc" },
        include: { user: userSummary },
      }),
      // Same `where` as the page above. An unfiltered count reads as correct
      // until the day a filter exists, and then reports the size of the table
      // rather than the size of the result.
      prismaAttendanceLog.count({ where }),
    ]);
    return { items, total };
  }

  return await prismaAttendanceLog.findMany({
    where,
    orderBy: { date: "desc" },
    include: { user: userSummary },
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
