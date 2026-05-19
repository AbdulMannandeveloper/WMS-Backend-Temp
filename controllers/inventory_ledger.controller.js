const inventoryLedgerLogic = require("../logic/inventory_ledger.logic");

const createInventoryLedgerEntry = async (req, res) => {
  try {
    const result = await inventoryLedgerLogic.createInventoryLedgerEntry(
      req.body,
    );
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
    const ledger = await inventoryLedgerLogic.getInventoryLedgerByField(
      field,
      value,
    );
    if (!ledger) {
      return res
        .status(404)
        .json({ error: "Inventory ledger entry not found" });
    }
    res.status(200).json(ledger);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

module.exports = {
  createInventoryLedgerEntry,
  getAllInventoryLedgers,
  getInventoryLedgerByField,
};
