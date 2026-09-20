const auditLogLogic = require("../logic/audit_log.logic");
const { paginatedResponse } = require("../utils/pagination");
const { buildListQuery } = require("../utils/queryFilters");
const { listError } = require("../utils/listResponse");

const getAllAuditLogs = async (req, res) => {
  try {
    const { where, orderBy, pagination } = buildListQuery(
      req.query,
      auditLogLogic.AUDIT_LOG_LIST_SPEC,
    );

    const result = await auditLogLogic.getAllAuditLogs(where, {
      orderBy,
      pagination,
    });

    return res
      .status(200)
      .json(paginatedResponse(result.items, result.total, pagination));
  } catch (err) {
    return listError(res, err, "getAllAuditLogs");
  }
};

/**
 * The figures above the table.
 *
 * Reads the same query string through the same spec, so the counts describe
 * exactly the rows the list is paging — and cover all of them, not the fifty on
 * screen. `orderBy` and `pagination` are built and discarded: they cannot
 * affect `where`, which is what makes the two endpoints agree by construction
 * rather than by being kept in step by hand.
 */
const getAuditLogSummary = async (req, res) => {
  try {
    const { where } = buildListQuery(
      req.query,
      auditLogLogic.AUDIT_LOG_LIST_SPEC,
    );

    return res.status(200).json(await auditLogLogic.summariseAuditLogs(where));
  } catch (err) {
    return listError(res, err, "getAuditLogSummary");
  }
};

module.exports = {
  getAllAuditLogs,
  getAuditLogSummary,
};
