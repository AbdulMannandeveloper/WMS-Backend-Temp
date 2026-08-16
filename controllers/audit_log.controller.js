const auditLogLogic = require("../logic/audit_log.logic");
const { parsePagination, paginatedResponse } = require("../utils/pagination");

const getAllAuditLogs = async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const result = await auditLogLogic.getAllAuditLogs(pagination);
    if (result && result.items) {
      return res.status(200).json(
        paginatedResponse(result.items, result.total, pagination),
      );
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  getAllAuditLogs,
};
