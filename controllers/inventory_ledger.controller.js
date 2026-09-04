const inventoryLedgerLogic = require("../logic/inventory_ledger.logic");
const auditLogLogic = require("../logic/audit_log.logic");
const { parsePagination, paginatedResponse } = require("../utils/pagination");
const { canAccessClientId } = require("../utils/clientScope");
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

const getAllInventoryLedgers = async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const result = await inventoryLedgerLogic.getAllInventoryLedgers(pagination);
    if (result && result.items) {
      return res.status(200).json(
        paginatedResponse(result.items, result.total, pagination),
      );
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
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

    const ledgers = await inventoryLedgerLogic.getInventoryLedgersByClientId(clientId);
    res.status(200).json(ledgers);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// US-058/059/060: Filtered ledger — ?startDate=&endDate=&productId=&clientId=&movementType=
const getLedgerWithFilters = async (req, res) => {
  try {
    const { startDate, endDate, productId, clientId, movementType } = req.query;
    const pagination = parsePagination(req.query);
    const result = await inventoryLedgerLogic.getLedgerWithFilters(
      {
        startDate,
        endDate,
        productId,
        clientId,
        movementType,
      },
      pagination,
    );
    if (result && result.items) {
      return res.status(200).json(
        paginatedResponse(result.items, result.total, pagination),
      );
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// US-054: Daily checkout summary — ?date=2026-06-14 (defaults to today)
const getDailyCheckoutSummary = async (req, res) => {
  try {
    const { date } = req.query;
    const summary = await inventoryLedgerLogic.getDailyCheckoutSummary(date);
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
  createInventoryLedgerEntry,
  checkInBatch,
  getAllInventoryLedgers,
  getInventoryLedgerByField,
  getInventoryLedgerByClientId,
  getLedgerWithFilters,
  getDailyCheckoutSummary,
};

