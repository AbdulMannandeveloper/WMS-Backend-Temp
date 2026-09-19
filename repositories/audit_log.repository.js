const { prisma } = require('../lib/prisma');

const prismaAuditLog = prisma.auditLog;

/**
 * A person, named — and nothing else.
 *
 * `user: true` returns every scalar on User, `passwordHash` among them. The
 * shipment repository already carries this fix and the comment explaining it;
 * this include was written the other way and every audit-log response has been
 * serialising staff credential material to the admin screen since.
 */
const userSummary = {
  select: { id: true, firstName: true, lastName: true, email: true },
};

const createAuditLog = async (data) => {
  return await prismaAuditLog.create({
    data,
  });
};

/**
 * @param {object} filters - a Prisma `where`; {} matches everything.
 * @param {object} [pagination] - { skip, take }. Absent, the whole set comes
 *   back as a bare array, which is what internal callers expect.
 */
const getAllAuditLogs = async (filters = {}, pagination) => {
  const where = filters;

  if (pagination && pagination.take != null) {
    const [items, total] = await Promise.all([
      prismaAuditLog.findMany({
        where,
        include: { user: userSummary },
        orderBy: { timestamp: 'desc' },
        skip: pagination.skip || 0,
        take: pagination.take,
      }),
      // Counted against the same `where` as the page. Counting everything
      // instead is invisible while nothing filters and a lie the moment
      // something does: five rows on screen, five hundred claimed below them.
      prismaAuditLog.count({ where }),
    ]);
    return { items, total };
  }

  return await prismaAuditLog.findMany({
    where,
    include: { user: userSummary },
    orderBy: { timestamp: 'desc' },
  });
};

module.exports = {
  createAuditLog,
  getAllAuditLogs,
};
