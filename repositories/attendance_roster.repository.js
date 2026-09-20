const { prisma } = require('../lib/prisma');

/**
 * The daily roster: one row per person, not one per log.
 *
 * The screen this backs lists every member of staff and shows what each of them
 * did on a given day — which means the rows are Users, and the logs are what
 * gets attached to them. Paginating the logs instead would page the wrong axis
 * entirely: fifty logs is not fifty people, and anybody without a log that day
 * would not appear at all, which is precisely the person a roster is for.
 */

// Never the whole User row: it carries passwordHash.
const rosterUserFields = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  username: true,
  role: true,
  isActive: true,
};

/**
 * @param {object} where - a Prisma where over User.
 * @param {object} [options]
 * @param {object[]} [options.orderBy]
 * @param {object} [options.pagination]
 */
const listRosterUsers = async (where = {}, { orderBy, pagination } = {}) => {
  const sort = orderBy || [
    { firstName: 'asc' },
    { lastName: 'asc' },
    { id: 'asc' },
  ];

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: rosterUserFields,
      orderBy: sort,
      ...(pagination && pagination.take != null
        ? { skip: pagination.skip || 0, take: pagination.take }
        : {}),
    }),
    // The same where as the page. This is what makes the count honest when a
    // status filter is applied, because the status filters below are relation
    // predicates rather than something applied after the rows come back.
    prisma.user.count({ where }),
  ]);

  return { items, total };
};

/**
 * Every log for one day, for the people on this page only.
 *
 * One query rather than one per row. Keyed on (userId, date), which the
 * uq_attendance_user_date unique already indexes.
 */
const logsForUsersOnDate = async (userIds, day) => {
  if (userIds.length === 0) return [];

  return await prisma.employeeAttendanceLog.findMany({
    where: { date: day, userId: { in: userIds } },
  });
};

/** How many people fall into each effective status, across the whole filter. */
const countRosterByStatus = async (baseWhere, day, isHoliday) => {
  const withLog = (status) => ({
    AND: [baseWhere, { attendanceLogs: { some: { date: day, status } } }],
  });
  const withoutLog = {
    AND: [baseWhere, { attendanceLogs: { none: { date: day } } }],
  };

  const [total, onTime, late, leave, unlogged] = await Promise.all([
    prisma.user.count({ where: baseWhere }),
    prisma.user.count({ where: withLog('on-time') }),
    prisma.user.count({ where: withLog('late') }),
    prisma.user.count({ where: withLog('leave') }),
    prisma.user.count({ where: withoutLog }),
  ]);

  // Someone with no log is absent on a working day and on holiday otherwise.
  // The same people, counted under whichever name the day makes true.
  return {
    total,
    onTime,
    late,
    leave,
    absent: isHoliday ? 0 : unlogged,
    holiday: isHoliday ? unlogged : 0,
  };
};

module.exports = {
  listRosterUsers,
  logsForUsersOnDate,
  countRosterByStatus,
};
