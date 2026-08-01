const { prisma } = require('../lib/prisma');

const prismaAuditLog = prisma.auditLog;

const createAuditLog = async (data) => {
  return await prismaAuditLog.create({
    data,
  });
};

const getAllAuditLogs = async () => {
  return await prismaAuditLog.findMany({
    include: { user: true },
    orderBy: { timestamp: 'desc' },
  });
};

module.exports = {
  createAuditLog,
  getAllAuditLogs,
};
