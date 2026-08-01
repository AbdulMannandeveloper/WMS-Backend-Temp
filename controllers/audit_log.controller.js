const auditLogLogic = require("../logic/audit_log.logic");

const getAllAuditLogs = async (req, res) => {
  try {
    const logs = await auditLogLogic.getAllAuditLogs();
    res.status(200).json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  getAllAuditLogs,
};
