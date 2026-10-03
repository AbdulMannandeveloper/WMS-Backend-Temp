const shipmentItemLogic = require("../logic/shipment_item.logic");
const productReturnLogic = require("../logic/product_return.logic");

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
    // The logic allowlists what a line may change; see ITEM_UPDATE_FIELDS.
    const updatedShipmentItem = await shipmentItemLogic.updateShipmentItem(
      id,
      req.body || {},
      req.user.id,
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
 * Returns part or all of a dispatched line to the shelf, booked as a return
 * record (productReturnLogic.recordLineReturn). The shipment's own charge is
 * deliberately untouched.
 */
const returnShipmentItem = async (req, res) => {
  try {
    const recorded = await productReturnLogic.recordLineReturn(
      req.params.id,
      {
        quantity: req.body?.quantity,
        reason: req.body?.reason,
        // Explicitly true only. Anything else — absent, "false", null — means
        // do not charge, because the safe reading of an unclear request about
        // money is the one that does not bill anybody.
        chargeReturn: req.body?.chargeReturn === true,
      },
      req.user.id,
    );
    // The record carries its invoice lines; prices stay with admins, as on
    // the Returns screen.
    res.status(200).json(productReturnLogic.redactMoney(recorded, req.user?.role));
  } catch (error) {
    const status = error.status || (/not found/i.test(error.message) ? 404 : 400);
    res.status(status).json({ error: error.message });
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
