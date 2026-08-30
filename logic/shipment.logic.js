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
const auditLogLogic = require("./audit_log.logic");
const {
  countShippedItems,
  getShipmentRateForClient,
  applyRecurringCharges,
} = require("./billing_services");
const { firstOfMonthUtc, addMonthsUtc } = require("../utils/dates");

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

/**
 * Finds the invoice a new charge should land on, creating it if needed.
 *
 * Normally that is the current month's. If it has already been APPROVED or PAID
 * the charge rolls forward to the next open period rather than being refused:
 * a closed accounting period should never block goods leaving the warehouse,
 * and the charge must not be silently dropped either. The line's dateOfService
 * still records when the work happened, so a later-period invoice explains
 * itself.
 *
 * Rolling forward rather than opening a second invoice for the same month is
 * also forced by the schema — monthly_invoices is unique on (client, period).
 */
const resolveOpenInvoice = async (clientId, tx, maxLookahead = 12) => {
  let period = firstOfMonthUtc();

  for (let i = 0; i <= maxLookahead; i++) {
    const existing =
      await monthlyInvoiceRepository.getMonthlyInvoiceByClientIdAndMonth(
        clientId,
        period,
        tx,
      );

    if (!existing) {
      const created = await monthlyInvoiceRepository.createMonthlyInvoice(
        { clientId, billingPeriod: period, status: "DRAFT" },
        tx,
      );
      // A newly opened period carries the client's standing charges from the
      // moment it exists, so storage and retainers do not depend on something
      // shipping. Idempotent, so the repeat calls on later dispatches are safe.
      await applyRecurringCharges(clientId, created, tx);
      return created;
    }

    if (existing.status === "DRAFT") {
      await applyRecurringCharges(clientId, existing, tx);
      return existing;
    }

    period = addMonthsUtc(period, 1);
  }

  throw new Error(
    "Could not find an open invoice to bill this shipment to — every period for the next year is already closed.",
  );
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

  // One transaction for the whole shipment. Previously the row was written
  // first and each item created in its own transaction, so a later line that
  // could not be reserved returned 400 while leaving the shipment, the earlier
  // items, and their stock reservations behind. The caller saw a failure and
  // assumed nothing had happened, and that stock stayed reserved against a
  // shipment nobody would ever pick or cancel.
  return prisma.$transaction(async (tx) => {
    const shipment = await shipmentRepositry.createShipment(shipmentData, tx);

    if (Array.isArray(shipmentItems)) {
      for (const item of shipmentItems) {
        await shipmentItemLogic.createShipmentItem(
          { ...item, shipmentId: shipment.id },
          { tx },
        );
      }
    }

    // Billable services applied to this shipment. Priced from the client's
    // agreed rate and frozen; dispatch raises invoice lines from these.
    if (Array.isArray(shipmentServices)) {
      for (const service of shipmentServices) {
        await ShipmentServiceMappingLogic.createShipmentServiceMapping(
          { ...service, shipmentId: shipment.id },
          tx,
        );
      }
    }

    const [createdItems, createdServices] = await Promise.all([
      shipmentItemLogic.getShipmentItemsByField("shipmentId", shipment.id, tx),
      ShipmentServiceMappingLogic.getShipmentServiceMappingsByField(
        "shipmentId",
        shipment.id,
        tx,
      ),
    ]);

    return {
      ...shipment,
      shipmentItems: createdItems,
      shipmentServices: createdServices,
    };
  }, {
    maxWait: 10_000,
    timeout: 30_000,
  });
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

    // The ledger records the person, so it must be a User id. The old
    // `|| shipment.employeeId` fallback would have written an Employee id into
    // a User foreign key; it only ever looked correct because the repository
    // happens to include employee.user. Fail loudly instead.
    const ledgerUserId = shipment.employee?.userId || shipment.employee?.user?.id;
    if (!ledgerUserId) {
      throw new Error(
        "Cannot dispatch: the assigned employee has no linked user account to attribute the stock movement to.",
      );
    }

    for (const item of shipmentItems) {
      await inventoryLedgerLogic.createInventoryLedger(
        {
          productId: item.productId,
          userId: ledgerUserId,
          movementType: "CHECKOUT",
          quantity: item.quantity,
          referenceId: shipment.id,
          fromLocationId: item.sourceLocationId,
        },
        { tx },
      );
    }

    const shipmentServices =
      await ShipmentServiceMappingLogic.getShipmentServiceMappingsByField(
        "shipmentId",
        shipmentId,
        tx,
      );

    // The client's agreed per-item dispatch rate, read now and written onto the
    // line, so a later rate change cannot rewrite a charge already raised.
    //
    // Null when the client has not bought that service, which is a real
    // arrangement rather than an error: a services-only client is stored and
    // handled here but ships through someone else.
    const shipmentRate = await getShipmentRateForClient(shipment.clientId, tx);
    const shippedItemCount = countShippedItems(shipmentItems);
    const hasShipmentCharge =
      shipmentRate !== null && shippedItemCount > 0 && Number(shipmentRate.unitPrice) > 0;

    // Nothing to charge at all: the goods still move, but do not open an empty
    // invoice just to hold no lines.
    if (hasShipmentCharge || shipmentServices.length > 0) {
      const monthlyInvoice = await resolveOpenInvoice(shipment.clientId, tx);
      const dispatchedAt = new Date();

      if (hasShipmentCharge) {
        const unitPrice = Number(shipmentRate.unitPrice);
        await invoiceLineItemRepository.createInvoiceLineItem(
          {
            invoiceId: monthlyInvoice.id,
            // Points at the agreed rate it came from, like every other line.
            clientServiceId: shipmentRate.clientService.id,
            // Per item, not per shipment. This was hardcoded to 1, so a
            // five-hundred-item shipment billed the same as a single-item one.
            quantity: shippedItemCount,
            unitPrice,
            totalPrice: Number((shippedItemCount * unitPrice).toFixed(2)),
            description: `Shipment dispatch — ${shippedItemCount} item(s), ${shipment.courierName} (${shipment.shipmentType}), shipment ${shipment.id}`,
            dateOfService: dispatchedAt,
            itemType: "SHIPMENT_CHARGE",
          },
          tx,
        );
      }

      for (const serviceMapping of shipmentServices) {
        // appliedUnitPrice was frozen when the service was attached, so a rate
        // change since then does not rewrite this charge.
        const unitPrice = serviceMapping.appliedUnitPrice;
        const quantity = serviceMapping.quantity;
        const totalPrice = Number(quantity) * Number(unitPrice);

        await invoiceLineItemRepository.createInvoiceLineItem(
          {
            invoiceId: monthlyInvoice.id,
            clientServiceId: serviceMapping.clientServiceId || null,
            quantity,
            unitPrice,
            totalPrice,
            description: `Charge for service "${serviceMapping.service?.description || serviceMapping.serviceId}" on shipment ${shipment.id}`,
            // When the work actually happened, even if it bills to a later
            // period because this month's invoice was already closed.
            dateOfService: dispatchedAt,
            itemType: "AUTOMATED_SERVICE",
          },
          tx,
        );
      }

      // The invoice total is derived from its line items, never accumulated here.
      await monthlyInvoiceRepository.recalculateInvoiceTotal(
        monthlyInvoice.id,
        tx,
      );
    }

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
/**
 * Sets, corrects or clears a shipment's courier consignment number.
 *
 * Separate from updateShipment on purpose. A shipment's commercial details are
 * frozen once DISPATCHED, but the tracking number is the one thing that
 * legitimately arrives *at* dispatch or shortly after it — the courier issues it
 * when they take the parcel. Routing it through the generic update meant it
 * could never be recorded on the shipments that actually have one.
 *
 * Open to employees as well as admins: whoever hands the parcel over is the
 * person holding the label. Refused only once CANCELLED, where there is no
 * parcel to track.
 *
 * Passing null or an empty string clears it, for a mis-key.
 */
const TRACKING_ID_MAX = 64; // matches shipments.tracking_id VarChar(64)
const TRACKING_ID_PATTERN = /^[A-Za-z0-9-]+$/;

const normaliseTrackingId = (raw) => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new Error("Tracking number must be text.");
  }

  // Couriers print these in spaced groups; operators copy them that way.
  const cleaned = raw.replace(/\s+/g, "");
  if (cleaned === "") return null;

  if (cleaned.length > TRACKING_ID_MAX) {
    throw new Error(
      `Tracking number is too long — ${TRACKING_ID_MAX} characters maximum.`,
    );
  }
  if (!TRACKING_ID_PATTERN.test(cleaned)) {
    throw new Error(
      "Tracking number may contain only letters, numbers and hyphens.",
    );
  }
  return cleaned;
};

const setShipmentTracking = async (id, trackingId, actorUserId) => {
  const shipment = await requireShipment(id);

  if (shipment.status === "CANCELLED") {
    throw new Error(
      "A cancelled shipment has no parcel to track.",
    );
  }

  const next = normaliseTrackingId(trackingId);

  const updated = await shipmentRepositry.updateShipment(id, { trackingId: next });

  await audit(actorUserId, next ? "SHIPMENT_TRACKING_SET" : "SHIPMENT_TRACKING_CLEARED", {
    shipmentId: id,
    from: shipment.trackingId ?? null,
    to: next,
    status: shipment.status,
  });

  return updated;
};

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
  setShipmentTracking,
  deleteShipment,
  // Exported for tests and for the item logic's own guards.
  SHIPMENT_TRANSITIONS,
  SHIPMENT_STATUSES,
  assertTransition,
  normaliseTrackingId,
};
