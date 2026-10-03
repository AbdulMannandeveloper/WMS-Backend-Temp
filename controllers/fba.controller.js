const fbaLogic = require('../logic/fba.logic');
const productReturnLogic = require('../logic/product_return.logic');
const { dependentsBody } = require('../utils/dependents');
const { resolveOwnClientId } = require('../utils/clientScope');

const fail = (res, error) => {
  // Something still depends on it: the 409 carries what, for the warning.
  if (error.code === 'HAS_DEPENDENTS') return res.status(409).json(dependentsBody(error));
  const status = error.status || (/not found/i.test(error.message) ? 404 : 400);
  res.status(status).json({ error: error.message });
};

// ─── Categories ───────────────────────────────────────────────────────────────

const createCategory = async (req, res) => {
  try {
    res.status(201).json(await fbaLogic.addCategory(req.body, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

const listCategories = async (req, res) => {
  try {
    res.status(200).json(await fbaLogic.getAllCategories());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateCategory = async (req, res) => {
  try {
    res.status(200).json(await fbaLogic.updateCategory(req.params.id, req.body, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

// What deleting a category would refuse on, asked before pressing it.
const getCategoryDependents = async (req, res) => {
  try {
    const { report } = await fbaLogic.getCategoryDependents(req.params.id);
    res.status(200).json(report);
  } catch (err) {
    fail(res, err);
  }
};

const deleteCategory = async (req, res) => {
  try {
    res.status(200).json(await fbaLogic.deleteCategory(req.params.id, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

// ─── Consignments ─────────────────────────────────────────────────────────────

// Step 1: open a bulk shipment with the products planned for it.
const createShipment = async (req, res) => {
  try {
    res.status(201).json(await fbaLogic.createBulkShipment(req.body, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

// Changing the planned products.
const setItems = async (req, res) => {
  try {
    res.status(200).json(
      await fbaLogic.setBulkItems(req.params.id, req.body?.lines, req.user.id),
    );
  } catch (err) {
    fail(res, err);
  }
};

// Step 2: record what the floor has picked against the plan.
const setPicks = async (req, res) => {
  try {
    res.status(200).json(
      await fbaLogic.recordPicks(req.params.id, req.body?.picks, req.user.id),
    );
  } catch (err) {
    fail(res, err);
  }
};

// Replacing its attached services, before dispatch (fba:update — see the route).
const setServices = async (req, res) => {
  try {
    res.status(200).json(
      await fbaLogic.setBulkServices(req.params.id, req.body?.services, req.user.id),
    );
  } catch (err) {
    fail(res, err);
  }
};

/**
 * The services a client has agreed rates for, to offer when attaching them.
 * Employees get the names only: what a client pays is admin information, and
 * the charge is raised automatically either way.
 */
const listAttachableServices = async (req, res) => {
  try {
    const rates = await fbaLogic.getAttachableServices(req.params.clientId);
    const showPrice = req.user.role === 'admin';
    res.status(200).json(
      rates.map((rate) => ({
        serviceId: rate.serviceId,
        description: rate.service.description,
        unit: rate.unit || rate.service.unit,
        isActive: rate.service.isActive,
        ...(showPrice ? { chargedPrice: rate.chargedPrice } : {}),
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** The delivery note PDF. A client may print their own, as with getShipment. */
const getDeliveryNote = async (req, res) => {
  try {
    const ownClientId = await resolveOwnClientId(req.user);
    const { shipment, buffer, filename } = await fbaLogic.getDeliveryNote(req.params.id);
    if (ownClientId && shipment.clientId !== ownClientId) {
      return res.status(404).json({ error: 'Consignment not found.' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(buffer);
  } catch (err) {
    fail(res, err);
  }
};

// A client change that would remove products or services is refused until it
// is confirmed, with the list of what would go so the screen can say so.
const failUpdate = (res, err) => {
  if (err.code === 'CONFIRM_CLIENT_RESET') {
    return res.status(409).json({ error: err.message, code: err.code, removes: err.removes });
  }
  return fail(res, err);
};

// Correcting its details (admin only — see the route).
const updateShipment = async (req, res) => {
  try {
    res.status(200).json(await fbaLogic.updateBulkShipment(req.params.id, req.body, req.user.id));
  } catch (err) {
    failUpdate(res, err);
  }
};

/**
 * Moving a shipment to another client, and nothing else — the route employees
 * use to put right a client picked by mistake. Only the client and the
 * confirmation are read from the body, so no other detail can ride along.
 */
const changeClient = async (req, res) => {
  try {
    if (!req.body?.clientId) return res.status(400).json({ error: 'A client is required.' });
    const shipment = await fbaLogic.getShipmentById(req.params.id);
    if (!['DRAFT', 'PREPARING'].includes(shipment.status)) {
      return res.status(400).json({
        error: `The client can only be changed before dispatch — this one is ${shipment.status}.`,
      });
    }
    res.status(200).json(
      await fbaLogic.updateBulkShipment(
        req.params.id,
        { clientId: req.body.clientId, confirmClientReset: req.body.confirmClientReset === true },
        req.user.id,
      ),
    );
  } catch (err) {
    failUpdate(res, err);
  }
};

/**
 * A client sees only their own consignments; staff see everything. Scoped the
 * same way as invoices, through resolveOwnClientId.
 */
const listShipments = async (req, res) => {
  try {
    const ownClientId = await resolveOwnClientId(req.user);
    const shipments = ownClientId
      ? await fbaLogic.getShipmentsByClientId(ownClientId)
      : await fbaLogic.getAllShipments();
    res.status(200).json(shipments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getShipment = async (req, res) => {
  try {
    const ownClientId = await resolveOwnClientId(req.user);
    const shipment = await fbaLogic.getShipmentById(req.params.id);
    // 404 rather than 403 for someone else's, so a client cannot probe which
    // consignment ids exist outside their own account.
    if (ownClientId && shipment.clientId !== ownClientId) {
      return res.status(404).json({ error: 'Consignment not found.' });
    }
    res.status(200).json(shipment);
  } catch (err) {
    fail(res, err);
  }
};

// Step 3: dispatch it.
const dispatchShipment = async (req, res) => {
  try {
    res.status(200).json(await fbaLogic.dispatchBulk(req.params.id, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

const cancelShipment = async (req, res) => {
  try {
    res
      .status(200)
      .json(await fbaLogic.cancel(req.params.id, req.body?.reason, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

// What deleting a bulk shipment would refuse on and undo.
const getShipmentDependents = async (req, res) => {
  try {
    const { report } = await fbaLogic.getBulkShipmentDependents(req.params.id);
    res.status(200).json(report);
  } catch (err) {
    fail(res, err);
  }
};

// Undoing what the line Return button booked before it made return records.
const getLineReturnDependents = async (req, res) => {
  try {
    const { report } = await fbaLogic.getBulkLineReturnDependents(req.params.id);
    res.status(200).json(report);
  } catch (err) {
    fail(res, err);
  }
};

const undoLineReturns = async (req, res) => {
  try {
    res.status(200).json(await fbaLogic.undoBulkLineReturns(req.params.id, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

const deleteShipment = async (req, res) => {
  try {
    const { restored = [], chargesRemoved = 0 } = await fbaLogic.remove(req.params.id, req.user.id);
    res.status(200).json({ message: 'Bulk shipment deleted.', restored, chargesRemoved });
  } catch (err) {
    fail(res, err);
  }
};

// The tracking number, at any status but voided — including after dispatch.
const setTracking = async (req, res) => {
  try {
    res.status(200).json(
      await fbaLogic.setBulkTracking(req.params.id, req.body?.trackingId ?? null, req.user.id),
    );
  } catch (err) {
    fail(res, err);
  }
};

/**
 * Returning part of a dispatched line. A return fee is only ever raised for an
 * admin who asked for one (explicitly true): employees do not see what a
 * client pays, so they cannot knowingly agree to charge it.
 */
const returnItem = async (req, res) => {
  try {
    const chargeReturn = req.user.role === 'admin' && req.body?.chargeReturn === true;
    // Books a return record (RET-…), as an outbound line's Return button does.
    const productReturn = await productReturnLogic.recordBulkLineReturn(
      req.params.id,
      req.params.itemId,
      { quantity: req.body?.quantity, reason: req.body?.reason, chargeReturn },
      req.user.id,
    );
    res.status(200).json({
      shipment: await fbaLogic.getShipmentById(req.params.id),
      returnCharge: productReturn.returnCharge,
      // Prices stay with admins, as on the Returns screen.
      productReturn: productReturnLogic.redactMoney(productReturn, req.user.role),
    });
  } catch (err) {
    fail(res, err);
  }
};

module.exports = {
  createCategory,
  listCategories,
  updateCategory,
  deleteCategory,
  getCategoryDependents,
  getShipmentDependents,
  getLineReturnDependents,
  undoLineReturns,
  createShipment,
  setItems,
  setPicks,
  setServices,
  changeClient,
  listAttachableServices,
  getDeliveryNote,
  updateShipment,
  setTracking,
  returnItem,
  listShipments,
  getShipment,
  dispatchShipment,
  cancelShipment,
  deleteShipment,
};
