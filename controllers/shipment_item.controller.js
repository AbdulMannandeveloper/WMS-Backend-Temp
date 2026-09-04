const shipmentItemLogic = require("../logic/shipment_item.logic");

const createShipmentItem = async (req, res) => {
  try {
    const shipmentItemData = req.body;
    const newShipmentItem =
      await shipmentItemLogic.createShipmentItem(shipmentItemData);
    res.status(201).json(newShipmentItem);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getShipmentItemsByField = async (req, res) => {
  try {
    const { field, value } = req.params;
    const shipmentItems = await shipmentItemLogic.getShipmentItemsByField(
      field,
      value,
    );
    res.status(200).json(shipmentItems);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const updateShipmentItem = async (req, res) => {
  try {
    const { id } = req.params;
    const shipmentItemData = req.body;
    const updatedShipmentItem = await shipmentItemLogic.updateShipmentItem(
      id,
      shipmentItemData,
    );
    res.status(200).json(updatedShipmentItem);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const pickShipmentItem = async (req, res) => {
  try {
    const item = await shipmentItemLogic.pickShipmentItem(
      req.params.id,
      req.user.id,
    );
    res.status(200).json(item);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

/**
 * Returns part or all of a dispatched line to the shelf. Admin only, and the
 * invoice is deliberately untouched.
 */
const returnShipmentItem = async (req, res) => {
  try {
    const updated = await shipmentItemLogic.returnShipmentItem(
      req.params.id,
      req.body?.quantity,
      req.body?.reason,
      req.user.id,
      // Explicitly true only. Anything else — absent, "false", null — means do
      // not charge, because the safe reading of an unclear request about money
      // is the one that does not bill anybody.
      { chargeReturn: req.body?.chargeReturn === true },
    );
    res.status(200).json(updated);
  } catch (error) {
    const notFound = /not found/i.test(error.message);
    res.status(notFound ? 404 : 400).json({ error: error.message });
  }
};

const unpickShipmentItem = async (req, res) => {
  try {
    const item = await shipmentItemLogic.unpickShipmentItem(
      req.params.id,
      req.user.id,
    );
    res.status(200).json(item);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const deleteShipmentItem = async (req, res) => {
  try {
    const { id } = req.params;
    await shipmentItemLogic.deleteShipmentItem(id);
    res.status(200).json({ message: "Shipment item deleted successfully." });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  createShipmentItem,
  getShipmentItemsByField,
  updateShipmentItem,
  pickShipmentItem,
  unpickShipmentItem,
  deleteShipmentItem,
  returnShipmentItem,
};
