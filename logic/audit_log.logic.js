const auditLogRepository = require('../repositories/audit_log.repository');

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

const getAllAuditLogs = async () => {
  return await auditLogRepository.getAllAuditLogs();
};

module.exports = {
  createAuditLog,
  getAllAuditLogs,
};
