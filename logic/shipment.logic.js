const { prisma } = require("../lib/prisma");
const shipmentRepositry = require("../repositories/shipment.repository");
const stockLevelRepository = require("../repositories/stock_level.repository");
const monthlyInvoiceRepository = require("../repositories/monthly_invoice.repository");
const invoiceLineItemRepository = require("../repositories/invoice_line_item.repository");

const shipmentItemLogic = require("./shipment_item.logic");
const employeeLogic = require("./employee.logic");
const clientLogic = require("./client.logic");
const inventoryLedgerLogic = require("./inventory_ledger.logic");
const ShipmentServiceMappingLogic = require("./shipment_service_mapping.logic");
const clientServiceLogic = require("./client_service.logic");
const auditLogLogic = require("./audit_log.logic");

/**
 * The shipment lifecycle, enforced here rather than in the browser.
 *
 * Until this existed the sequence lived only in the React page, and the API
 * accepted any status from anyone — an employee could PUT a shipment straight to
 * DISPATCHED and skip the stock deduction, the ledger entry and the billing that
 * the real dispatch performs, leaving the books and the shelves disagreeing.
 *
 * DISPATCHED and CANCELLED are terminal. `reopen` (READY_FOR_DISPATCH → PENDING)
 * exists so a shipment marked ready by mistake is not a dead end.
 */
const SHIPMENT_TRANSITIONS = {
  PENDING: ["READY_FOR_DISPATCH", "CANCELLED"],
  READY_FOR_DISPATCH: ["DISPATCHED", "PENDING", "CANCELLED"],
  DISPATCHED: [],
  CANCELLED: [],
};

const SHIPMENT_STATUSES = Object.keys(SHIPMENT_TRANSITIONS);

/** Statuses past which a shipment's commercial details are frozen. */
const IMMUTABLE_STATUSES = ["DISPATCHED", "CANCELLED"];

const assertTransition = (from, to) => {
  const allowed = SHIPMENT_TRANSITIONS[from];
  if (!allowed) {
    throw new Error(`Shipment has an unrecognised status: ${from}.`);
  }
  if (!allowed.includes(to)) {
    const options = allowed.length
      ? allowed.join(", ")
      : "nothing — it is a final state";
    throw new Error(
      `A ${from} shipment cannot become ${to}. Allowed from ${from}: ${options}.`,
    );
  }
};

/** Loads a shipment or throws. Shared by every transition below. */
const requireShipment = async (id, tx) => {
  const shipment = await shipmentRepositry.getShipmentByField("id", id, tx);
  if (!shipment) {
    throw new Error("Shipment not found.");
  }
  return shipment;
};

/** Audit failures must never roll back the operation they describe. */
const audit = (actorUserId, action, details) => {
  if (!actorUserId) return Promise.resolve(null);
  return auditLogLogic
    .createAuditLog(actorUserId, action, details)
    .catch((err) => console.error(`Audit log error (${action}):`, err.message));
};

const createShipment = async (data) => {
  if (!data.employeeId || !data.clientId || !data.shipmentType) {
    throw new Error(
      "Employee ID, Client ID, and Shipment Type are required to create a shipment.",
    );
  }

  const employee = await employeeLogic.getEmployeeById(data.employeeId);
  const client = await clientLogic.getClientById(data.clientId);
  if (!employee) {
    throw new Error("Employee not found.");
  }
  if (!client) {
    throw new Error("Client not found.");
  }

  // A shipment always starts at PENDING. Callers do not get to choose a
  // starting state — that would be a transition, and transitions are guarded.
  const { shipmentItems, shipmentServices, status, ...shipmentData } = data;
  shipmentData.status = "PENDING";
  const shipment = await shipmentRepositry.createShipment(shipmentData);

  if (data.shipmentItems && Array.isArray(data.shipmentItems)) {
    for (const item of data.shipmentItems) {
      item.shipmentId = shipment.id;
      await shipmentItemLogic.createShipmentItem(item);
    }
  }
  const createdShipmentItems = await shipmentItemLogic.getShipmentItemsByField(
    "shipmentId",
    shipment.id,
  );
  return { ...shipment, shipmentItems: createdShipmentItems };
};

const getAllShipments = async () => {
  return await shipmentRepositry.getAllShipments();
};

const getShipmentByField = async (field, value) => {
  return await shipmentRepositry.getShipmentByField(field, value);
};

const getShipmentsByClientId = async (clientId) => {
  return await shipmentRepositry.getShipmentsByClientId(clientId);
};

/**
 * Dispatch a shipment: status flip + inventory checkouts + invoice lines
 * all commit or roll back together.
 */
const dispatchShipment = async (shipmentId, actorUserId) => {
  const shipment = await requireShipment(shipmentId);
  assertTransition(shipment.status, "DISPATCHED");

  const result = await prisma.$transaction(async (tx) => {
    await tx.shipment.update({
      where: { id: shipmentId },
      data: { status: "DISPATCHED" },
    });

    const shipmentItems = await tx.shipmentItem.findMany({
      where: { shipmentId },
    });

    const actorUserId =
      shipment.employee?.userId ||
      shipment.employee?.user?.id ||
      shipment.employeeId;

    for (const item of shipmentItems) {
      await inventoryLedgerLogic.createInventoryLedger(
        {
          productId: item.productId,
          userId: actorUserId,
          movementType: "CHECKOUT",
          quantity: item.quantity,
          referenceId: shipment.id,
          fromLocationId: item.sourceLocationId,
        },
        { tx },
      );
    }

    const billingMonth = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1,
    );

    let monthlyInvoice =
      await monthlyInvoiceRepository.getMonthlyInvoiceByClientIdAndMonth(
        shipment.clientId,
        billingMonth,
        tx,
      );
    if (!monthlyInvoice) {
      monthlyInvoice = await monthlyInvoiceRepository.createMonthlyInvoice(
        {
          clientId: shipment.clientId,
          billingPeriod: billingMonth,
          status: "DRAFT",
        },
        tx,
      );
    }

    const shipmentServices =
      await ShipmentServiceMappingLogic.getShipmentServiceMappingsByField(
        "shipmentId",
        shipmentId,
      );

    for (const serviceMapping of shipmentServices) {
      const clientService =
        await clientServiceLogic.getClientServiceByClientIdAndServiceId(
          shipment.clientId,
          serviceMapping.serviceId,
        );

      const unitPrice = serviceMapping.appliedUnitPrice;
      const quantity = serviceMapping.quantity;
      const totalPrice = quantity * unitPrice;

      await invoiceLineItemRepository.createInvoiceLineItem(
        {
          invoiceId: monthlyInvoice.id,
          clientServiceId: clientService ? clientService.id : null,
          quantity,
          unitPrice,
          totalPrice,
          description: `Charge for service "${serviceMapping.service?.description || serviceMapping.serviceId}" on shipment ${shipment.id}`,
          dateOfService: new Date(),
          itemType: "AUTOMATED_SERVICE",
        },
        tx,
      );
    }

    // The invoice total is derived from its line items, never accumulated here.
    await monthlyInvoiceRepository.recalculateInvoiceTotal(monthlyInvoice.id, tx);

    return await shipmentRepositry.getShipmentByField("id", shipmentId, tx);
  }, {
    maxWait: 10_000,
    timeout: 60_000,
  });

  await audit(actorUserId, "SHIPMENT_DISPATCHED", {
    shipmentId,
    clientId: shipment.clientId,
    courierName: shipment.courierName,
    itemCount: shipment.shipmentItems?.length ?? 0,
  });

  return result;
};

/**
 * PENDING → READY_FOR_DISPATCH. Every line must be off the shelf first: this is
 * the rule the "mark ready" button enforced in the browser, now enforced here.
 */
const markShipmentReady = async (shipmentId, actorUserId) => {
  const shipment = await requireShipment(shipmentId);
  assertTransition(shipment.status, "READY_FOR_DISPATCH");

  const items = await shipmentItemLogic.getShipmentItemsByField(
    "shipmentId",
    shipmentId,
  );

  if (items.length === 0) {
    throw new Error("A shipment cannot be marked ready with no items on it.");
  }

  const unpicked = items.filter((item) => item.status !== "PICKED");
  if (unpicked.length > 0) {
    throw new Error(
      `${unpicked.length} of ${items.length} item(s) have not been picked yet.`,
    );
  }

  const updated = await shipmentRepositry.updateShipment(shipmentId, {
    status: "READY_FOR_DISPATCH",
  });

  await audit(actorUserId, "SHIPMENT_READY", {
    shipmentId,
    itemCount: items.length,
  });

  return updated;
};

/** READY_FOR_DISPATCH → PENDING, so a premature "ready" is recoverable. */
const reopenShipment = async (shipmentId, actorUserId) => {
  const shipment = await requireShipment(shipmentId);
  assertTransition(shipment.status, "PENDING");

  const updated = await shipmentRepositry.updateShipment(shipmentId, {
    status: "PENDING",
  });

  await audit(actorUserId, "SHIPMENT_REOPENED", {
    shipmentId,
    previousStatus: shipment.status,
  });

  return updated;
};

/**
 * Cancels a shipment and hands its reserved stock back.
 *
 * Preferred over DELETE: the record survives, so the reservation history stays
 * explicable. Reserved quantity is released in the same transaction as the
 * status change, or the stock stays locked against a dead shipment.
 */
const cancelShipment = async (shipmentId, actorUserId, reason) => {
  const shipment = await requireShipment(shipmentId);
  assertTransition(shipment.status, "CANCELLED");

  const updated = await prisma.$transaction(async (tx) => {
    const items = await tx.shipmentItem.findMany({ where: { shipmentId } });

    for (const item of items) {
      const sourceStock =
        await stockLevelRepository.getStockLevelByProductAndLocation(
          item.productId,
          item.sourceLocationId,
          tx,
        );
      if (sourceStock) {
        await stockLevelRepository.releaseReservedStockAtomically(
          sourceStock.id,
          item.quantity,
          tx,
        );
      }
    }

    return await shipmentRepositry.updateShipment(
      shipmentId,
      { status: "CANCELLED" },
      tx,
    );
  }, {
    maxWait: 10_000,
    timeout: 30_000,
  });

  await audit(actorUserId, "SHIPMENT_CANCELLED", {
    shipmentId,
    previousStatus: shipment.status,
    reason: reason || null,
  });

  return updated;
};

/**
 * Edits a shipment's commercial and identity details. Admin-only at the route,
 * and refused once the shipment has left the building — what was dispatched
 * under one courier cannot retroactively have gone under another.
 *
 * `status` is deliberately not editable here; use the transitions above.
 */
const updateShipment = async (id, data, actorUserId) => {
  const shipment = await requireShipment(id);

  if (IMMUTABLE_STATUSES.includes(shipment.status)) {
    throw new Error(
      `A ${shipment.status} shipment can no longer be edited.`,
    );
  }

  if (data.status !== undefined) {
    throw new Error(
      "Status cannot be changed here. Use the ready, dispatch, cancel or reopen actions.",
    );
  }

  const updated = await shipmentRepositry.updateShipment(id, data);

  await audit(actorUserId, "SHIPMENT_UPDATED", {
    shipmentId: id,
    changed: Object.keys(data),
  });

  return updated;
};

/**
 * Hard-deletes a shipment, for genuine mis-keys only.
 *
 * Refused once DISPATCHED. Previously this deleted the row regardless and merely
 * skipped the stock release, which destroyed the record of goods that had
 * physically left while their inventory_ledger rows survived pointing at a
 * shipment id that no longer existed. Cancel a dispatched shipment's successor
 * paperwork instead; the ledger is the audit trail.
 */
const deleteShipment = async (id, actorUserId) => {
  const shipment = await requireShipment(id);

  if (shipment.status === "DISPATCHED") {
    throw new Error(
      "A dispatched shipment cannot be deleted — its inventory movements reference it. Cancel or credit it instead.",
    );
  }

  const deleted = await prisma.$transaction(async (tx) => {
    // A cancelled shipment already handed its reservation back.
    if (shipment.status !== "CANCELLED") {
      const shipmentItems = await tx.shipmentItem.findMany({
        where: { shipmentId: id },
      });
      for (const item of shipmentItems) {
        const sourceStock =
          await stockLevelRepository.getStockLevelByProductAndLocation(
            item.productId,
            item.sourceLocationId,
            tx,
          );
        if (sourceStock) {
          await stockLevelRepository.releaseReservedStockAtomically(
            sourceStock.id,
            item.quantity,
            tx,
          );
        }
      }
    }

    return await shipmentRepositry.deleteShipment(id, tx);
  }, {
    maxWait: 10_000,
    timeout: 30_000,
  });

  await audit(actorUserId, "SHIPMENT_DELETED", {
    shipmentId: id,
    status: shipment.status,
    clientId: shipment.clientId,
  });

  return deleted;
};

module.exports = {
  createShipment,
  dispatchShipment,
  markShipmentReady,
  reopenShipment,
  cancelShipment,
  getAllShipments,
  getShipmentByField,
  getShipmentsByClientId,
  updateShipment,
  deleteShipment,
  // Exported for tests and for the item logic's own guards.
  SHIPMENT_TRANSITIONS,
  SHIPMENT_STATUSES,
  assertTransition,
};
