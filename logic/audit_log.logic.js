const auditLogRepository = require('../repositories/audit_log.repository');
const {
  dateRangeFilter,
  parseString,
  parseUuid,
  personNameFilter,
} = require('../utils/queryFilters');

const createAuditLog = async (userId, action, details) => {
  if (!userId) {
    throw new Error('userId is required for audit logging.');
  }
  if (!action) {
    throw new Error('action is required for audit logging.');
  }

  const detailsStr = typeof details === 'object' ? JSON.stringify(details) : details || '';

  return await auditLogRepository.createAuditLog({
    userId,
    action,
    details: detailsStr,
  });
};

/**
 * What the audit list may be narrowed by.
 *
 * Exported because the /summary handler builds its `where` from this same
 * object and the same req.query. That is what stops the two drifting: the
 * counts under the table cannot describe a different set of rows from the ones
 * in it, because neither handler gets to decide independently what the filter
 * means.
 *
 * `action` is a plain String column rather than an enum — the values are
 * written by the code that raises the log — so it is matched exactly rather
 * than checked against an allowlist that would go stale.
 */
const AUDIT_LOG_LIST_SPEC = {
  filters: [
    (q) => {
      const term = parseString(q.search, { label: 'search', maxLength: 128 });
      if (!term) return undefined;
      const byPerson = personNameFilter(term, 'user');
      return {
        OR: [
          { action: { contains: term, mode: 'insensitive' } },
          { details: { contains: term, mode: 'insensitive' } },
          ...byPerson.OR,
        ],
      };
    },
    (q) => {
      const action = parseString(q.action, { label: 'action', maxLength: 80 });
      return action ? { action } : undefined;
    },
    (q) => {
      const userId = parseUuid(q.userId, 'userId');
      return userId ? { userId } : undefined;
    },
    (q) => {
      const range = dateRangeFilter(q.startDate, q.endDate, {
        granularity: 'timestamp',
      });
      return range ? { timestamp: range } : undefined;
    },
  ],
  sort: {
    allowed: {
      timestamp: (order) => ({ timestamp: order }),
      action: (order) => ({ action: order }),
      userName: (order) => [
        { user: { firstName: order } },
        { user: { lastName: order } },
      ],
    },
    defaultSort: { field: 'timestamp', order: 'desc' },
    tiebreaker: [{ id: 'asc' }],
  },
};

const getAllAuditLogs = async (where, options) =>
  await auditLogRepository.getAllAuditLogs(where, options);

const summariseAuditLogs = async (where) =>
  await auditLogRepository.summariseAuditLogs(where);

module.exports = {
  AUDIT_LOG_LIST_SPEC,
  createAuditLog,
  getAllAuditLogs,
  summariseAuditLogs,
};
