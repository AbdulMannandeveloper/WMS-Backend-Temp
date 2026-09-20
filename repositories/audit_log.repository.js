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
 * @param {object} where - a Prisma `where`; {} matches everything.
 * @param {object} [options]
 * @param {object[]} [options.orderBy] - ends in a unique key, or pages repeat rows.
 * @param {object} [options.pagination] - { skip, take }. Absent, the whole set
 *   comes back as a bare array, which is what internal callers read.
 */
const getAllAuditLogs = async (where = {}, { orderBy, pagination } = {}) => {
  const sort = orderBy || [{ timestamp: 'desc' }, { id: 'asc' }];

  if (pagination && pagination.take != null) {
    const [items, total] = await Promise.all([
      prismaAuditLog.findMany({
        where,
        include: { user: userSummary },
        orderBy: sort,
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
    orderBy: sort,
  });
};

/**
 * Totals across the whole filtered set, not the page.
 *
 * The counts under the table describe every row the filter matches — which is
 * the entire reason this is a query rather than a reduce over `items`. A tally
 * of the fifty rows on screen would be a different number with every page turn.
 */
const summariseAuditLogs = async (where = {}) => {
  const [total, byAction] = await Promise.all([
    prismaAuditLog.count({ where }),
    prismaAuditLog.groupBy({
      by: ['action'],
      where,
      _count: { _all: true },
      orderBy: { _count: { action: 'desc' } },
    }),
  ]);

  return {
    total,
    byAction: byAction.map((row) => ({
      action: row.action,
      count: row._count._all,
    })),
  };
};

module.exports = {
  createAuditLog,
  getAllAuditLogs,
  summariseAuditLogs,
};
