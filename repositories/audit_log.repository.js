const { prisma } = require('../lib/prisma');

const prismaAuditLog = prisma.auditLog;

const createAuditLog = async (data) => {
  return await prismaAuditLog.create({
    data,
  });
};

const getAllAuditLogs = async (pagination) => {
  if (pagination && pagination.take != null) {
    const [items, total] = await Promise.all([
      prismaAuditLog.findMany({
        include: { user: true },
        orderBy: { timestamp: 'desc' },
        skip: pagination.skip || 0,
        take: pagination.take,
      }),
      prismaAuditLog.count(),
    ]);
    return { items, total };
  }

  return await prismaAuditLog.findMany({
    include: { user: true },
    orderBy: { timestamp: 'desc' },
  });
};

module.exports = {
  createAuditLog,
  getAllAuditLogs,
};
