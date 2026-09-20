const inventoryLedgerLogic = require("../logic/inventory_ledger.logic");
const auditLogLogic = require("../logic/audit_log.logic");
const { parsePagination, paginatedResponse } = require("../utils/pagination");
const { canAccessClientId, resolveClientFilter } = require("../utils/clientScope");
const { buildListQuery, parseUuid, withScope } = require("../utils/queryFilters");
const { listError } = require("../utils/listResponse");
const receivingLogic = require("../logic/receiving.logic");

const createInventoryLedgerEntry = async (req, res) => {
  try {
    const result = await inventoryLedgerLogic.createInventoryLedger({ ...req.body, userId: req.user.id });
    const adminUserId = req.user.id;
    if (adminUserId) {
      await auditLogLogic.createAuditLog(adminUserId, "ADJUST_STOCK", {
        ledgerId: result.id,
        productId: result.productId,
        movementType: result.movementType,
        quantity: result.quantity,
        fromLocationId: result.fromLocationId,
        toLocationId: result.toLocationId,
        notes: result.notes,
      }).catch(err => console.error("Audit log error:", err.message));
    }
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

/**
 * The ledger.
 *
 * clientId goes through resolveClientFilter even though this route is
 * staff-only today. The value and the caller identity then cannot disagree, so
 * opening the route to the client role later is a change to the route line
 * rather than a leak waiting in the query handling.
 */
const getAllInventoryLedgers = async (req, res) => {
  try {
    const scope = await resolveClientFilter(
      req.user,
      parseUuid(req.query.clientId, "clientId"),
    );
    const { where, orderBy, pagination } = buildListQuery(
      req.query,
      inventoryLedgerLogic.INVENTORY_LEDGER_LIST_SPEC,
    );

    const result = await inventoryLedgerLogic.getAllInventoryLedgers(
      withScope(where, scope ? inventoryLedgerLogic.clientScopeClause(scope) : null),
      { orderBy, pagination },
    );

    return res
      .status(200)
      .json(paginatedResponse(result.items, result.total, pagination));
  } catch (err) {
    return listError(res, err, "getAllInventoryLedgers");
  }
};

/** Movement counts and quantities across the whole filtered set. */
const getInventoryLedgerSummary = async (req, res) => {
  try {
    const scope = await resolveClientFilter(
      req.user,
      parseUuid(req.query.clientId, "clientId"),
    );
    const { where } = buildListQuery(
      req.query,
      inventoryLedgerLogic.INVENTORY_LEDGER_LIST_SPEC,
    );

    return res.status(200).json(
      await inventoryLedgerLogic.summariseInventoryLedgers(
        withScope(where, scope ? inventoryLedgerLogic.clientScopeClause(scope) : null),
      ),
    );
  } catch (err) {
    return listError(res, err, "getInventoryLedgerSummary");
  }
};

const getInventoryLedgerByField = async (req, res) => {
  try {
    const { field, value } = req.params;
    const ledger = await inventoryLedgerLogic.getInventoryLedgerByField(field, value);
    if (!ledger) {
      return res.status(404).json({ error: "Inventory ledger entry not found" });
    }
    res.status(200).json(ledger);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const getInventoryLedgerByClientId = async (req, res) => {
  try {
    const { clientId } = req.params;

    // A client may only read their own ledger. Staff (admin/employee) may read any.
    if (!(await canAccessClientId(req.user, clientId))) {
      return res.status(403).json({ error: "You do not have access to this client's records." });
    }

    const { where, orderBy, pagination } = buildListQuery(
      req.query,
      inventoryLedgerLogic.INVENTORY_LEDGER_LIST_SPEC,
    );

    const result = await inventoryLedgerLogic.getInventoryLedgersByClientId(
      clientId,
      where,
      { orderBy, pagination },
    );

    return res
      .status(200)
      .json(paginatedResponse(result.items, result.total, pagination));
  } catch (err) {
    return listError(res, err, "getInventoryLedgerByClientId");
  }
};

// US-058/059/060: kept as an alias of the list above, which now takes the same
// parameters and more. Two paths, one handler — so they cannot drift while the
// front end moves over.
const getLedgerWithFilters = getAllInventoryLedgers;

// US-054: Daily checkout summary —
// ?startDate=2026-06-14&endDate=2026-06-20&clientId= (all optional, defaults to today)
const getDailyCheckoutSummary = async (req, res) => {
  try {
    const { startDate, endDate, clientId } = req.query;
    const summary = await inventoryLedgerLogic.getDailyCheckoutSummary({
      startDate,
      endDate,
      clientId,
    });
    res.status(200).json(summary);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

/**
 * Books a whole delivery in at once.
 *
 * The basket is built on the scanning bench and arrives here as one payload, so
 * a pallet of mixed stock is one transaction rather than one request per
 * carton. The actor comes from the session, never the body.
 */
const checkInBatch = async (req, res) => {
  try {
    const result = await receivingLogic.checkInBatch(req.body, req.user.id);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

module.exports = {
  getInventoryLedgerSummary,
  createInventoryLedgerEntry,
  checkInBatch,
  getAllInventoryLedgers,
  getInventoryLedgerByField,
  getInventoryLedgerByClientId,
  getLedgerWithFilters,
  getDailyCheckoutSummary,
};

