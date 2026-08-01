const inventoryLedgerLogic = require("../logic/inventory_ledger.logic");
const auditLogLogic = require("../logic/audit_log.logic");

const createInventoryLedgerEntry = async (req, res) => {
  try {
    const result = await inventoryLedgerLogic.createInventoryLedger(req.body);
    const adminUserId = req.header("x-user-id") || (req.user && req.user.id);
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
    const ledgers = await inventoryLedgerLogic.getAllInventoryLedgers();
    res.status(200).json(ledgers);
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
    const ledgers = await inventoryLedgerLogic.getLedgerWithFilters({
      startDate,
      endDate,
      productId,
      clientId,
      movementType,
    });
    res.status(200).json(ledgers);
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

module.exports = {
  createInventoryLedgerEntry,
  getAllInventoryLedgers,
  getInventoryLedgerByField,
  getInventoryLedgerByClientId,
  getLedgerWithFilters,
  getDailyCheckoutSummary,
};

