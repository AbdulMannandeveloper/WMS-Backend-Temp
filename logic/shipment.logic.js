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
  resolveOpenInvoiceFor,
} = require("./billing_services");
const { firstOfMonthUtc, addMonthsUtc } = require("../utils/dates");
const { buildReport, assertDeletable, lockForDelete } = require("../utils/dependents");
const { freeUnitsIn, takeOffShelf, paidAmong, removeChargeLines, syncInvoicePdfs } = require("./reversal");

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

// resolveOpenInvoice moved to ./billing_services, so FBA consignments and
// ordinary dispatch resolve a billing period through the same code. Two copies
// of that rule is how a client once ended up with two invoices for one month.
const resolveOpenInvoice = resolveOpenInvoiceFor;

/** Audit failures must never roll back the operation they describe. */
const audit = (actorUserId, action, details) => {
  if (!actorUserId) return Promise.resolve(null);
  return auditLogLogic
    .createAuditLog(actorUserId, action, details)
    .catch((err) => console.error(`Audit log error (${action}):`, err.message));
};


/**
 * Everything dispatching a shipment does beyond setting its status: the stock
 * leaves, and the client is charged.
 *
 * Shared because a shipment is now dispatched at the moment it is created, and
 * the old two-step path still exists for the rows that predate that. Two copies
 * of this would be two chances for the shelves and the invoice to disagree.
 *
 * @param actorUserId whoever is signed in — the ledger records a person, and
 *   that person is a User. It used to be read off the shipment's Employee,
 *   which is why an admin could not dispatch at all.
 */
const applyDispatchEffects = async (shipment, actorUserId, tx) => {
  if (!actorUserId) {
    throw new Error("An authenticated user is required to dispatch stock.");
  }

  const shipmentItems = await tx.shipmentItem.findMany({
    where: { shipmentId: shipment.id },
  });

  for (const item of shipmentItems) {
    await inventoryLedgerLogic.createInventoryLedger(
      {
        productId: item.productId,
        userId: actorUserId,
        movementType: "CHECKOUT",
        quantity: item.quantity,
        // The scanned label, not the row's uuid. This is what is written on the
        // parcel, what the client quotes, and what appears on the invoice line —
        // a movement identified by a uuid could not be tied to any of them
        // without a second lookup.
        referenceId: shipment.reference,
        fromLocationId: item.sourceLocationId,
      },
      { tx },
    );
  }

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

  // Nothing to charge: the goods still move, but do not open an empty invoice
  // just to hold no lines.
  if (!hasShipmentCharge) return;

  const monthlyInvoice = await resolveOpenInvoice(shipment.clientId, tx);
  const unitPrice = Number(shipmentRate.unitPrice);

  await invoiceLineItemRepository.createInvoiceLineItem(
    {
      invoiceId: monthlyInvoice.id,
      clientServiceId: shipmentRate.clientService.id,
      // The shipment this charge belongs to, so deleting the shipment can find
      // and reverse this exact line by id rather than parsing its description.
      shipmentId: shipment.id,
      // Per item, not per shipment. This was hardcoded to 1, so a
      // five-hundred-item shipment billed the same as a single-item one.
      quantity: shippedItemCount,
      unitPrice,
      totalPrice: Number((shippedItemCount * unitPrice).toFixed(2)),
      // Names the scanned label rather than the uuid: that is what is written
      // on the parcel and what a client quotes when they query the line.
      description: `Shipment ${shipment.reference} — ${shippedItemCount} item(s) dispatched`,
      dateOfService: new Date(),
      itemType: "SHIPMENT_CHARGE",
    },
    tx,
  );

  // The invoice total is derived from its line items, never accumulated here.
  await monthlyInvoiceRepository.recalculateInvoiceTotal(monthlyInvoice.id, tx);
};

/**
 * The one client a shipment belongs to, worked out from the goods on it.
 *
 * Asking for the client before anything is picked was the wrong order: the
 * goods already know whose they are. Refusing a mixed shipment matters because
 * the stock is not theirs and the charge would land on the wrong invoice.
 */
const clientFromItems = async (shipmentItems, tx) => {
  if (!Array.isArray(shipmentItems) || shipmentItems.length === 0) {
    throw new Error("Add at least one product before creating a shipment.");
  }

  const db = tx || prisma;
  let clientId = null;
  let clientName = null;

  for (const item of shipmentItems) {
    const product = await db.product.findUnique({
      where: { id: item.productId },
      include: { client: true },
    });
    if (!product) {
      throw new Error("One of the products on this shipment no longer exists.");
    }

    if (clientId === null) {
      clientId = product.clientId;
      clientName = product.client?.companyName ?? "that client";
      continue;
    }

    if (product.clientId !== clientId) {
      throw new Error(
        `${product.productName} belongs to ${product.client?.companyName ?? "another client"}. ` +
          `A shipment can only carry one client's goods, and this one is ${clientName}'s.`,
      );
    }
  }

  return clientId;
};

/* ── The shipment reference ───────────────────────────────────────────────
 *
 * Issued here, not scanned. The bench used to key in the number printed on the
 * parcel, which made the warehouse responsible for an identity the system needs
 * to be unique: a mistyped digit collided with an older shipment, and a label
 * roll starting over collided with everything. So the parcel carries whatever
 * the courier put on it, and the shipment carries a number of our own.
 *
 * Format: SHP-<year>-<sequence>, e.g. SHP-2026-000123. The year scopes the
 * sequence so it restarts each January and stays short enough to read aloud.
 * The sequence is zero-padded to a fixed width, which is what lets the next
 * number be found with a single indexed "highest so far" read — without the
 * padding, SHP-2026-10000 would sort below SHP-2026-9999.
 */
const REFERENCE_PREFIX = "SHP";
const REFERENCE_DIGITS = 6;

/** How many times a reference collision is worth retrying before giving up. */
const REFERENCE_ATTEMPTS = 5;

/** How far down the series to look for a reference this scheme wrote. */
const REFERENCE_SCAN = 10;

const referenceSeriesFor = (date) =>
  `${REFERENCE_PREFIX}-${date.getUTCFullYear()}-`;

/**
 * The next reference in this year's series.
 *
 * Takes a transaction so the count it continues from is committed state rather
 * than whatever was true when the request arrived.
 */
const nextReference = async (tx) => {
  const series = referenceSeriesFor(new Date());
  const recent = await shipmentRepositry.getLatestReferencesInSeries(
    series,
    REFERENCE_SCAN,
    tx,
  );

  // The first that parses wins. A hand-written reference sharing the prefix
  // sorts above the generated ones and would otherwise read as NaN, sending the
  // sequence back to 1 and colliding with the shipment already holding it.
  let last = 0;
  for (const row of recent) {
    const tail = row.reference.slice(series.length);
    if (!/^\d+$/.test(tail)) continue;
    last = Number.parseInt(tail, 10);
    break;
  }

  return `${series}${String(last + 1).padStart(REFERENCE_DIGITS, "0")}`;
};

/**
 * Whether this failure is two dispatches having picked the same number.
 *
 * Only that one index: any other unique violation is a real problem and has to
 * surface rather than be retried into the same failure five times.
 */
const isReferenceClash = (error) => {
  if (error?.code !== "P2002") return false;
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some((f) => String(f ?? "").includes("reference"));
};

/**
 * Creates a shipment and dispatches it in the same act.
 *
 * There is no longer a PENDING → READY → DISPATCHED walk. The parcel is packed
 * and the label is on it before anyone touches this screen, so the three states
 * described a process that had already happened. Stock leaves and the client is
 * charged here.
 *
 * @param actorUserId whoever is signed in. Never taken from the body.
 */
const createShipment = async (data, actorUserId) => {
  if (!actorUserId) {
    throw new Error("An authenticated user is required to create a shipment.");
  }

  // Everything the caller is not allowed to decide is stripped here: the
  // reference is issued by this function, the client comes from the goods, the
  // creator from the session, the status from this function, and billable
  // services are no longer attached at dispatch. `reference` is pulled out of
  // the body and dropped rather than passed through — a caller naming its own
  // label would be able to collide with, or jump ahead of, the series.
  const {
    shipmentItems,
    shipmentServices,
    status,
    clientId,
    employeeId,
    reference: ignoredReference,
    ...rest
  } = data;

  const derivedClientId = await clientFromItems(shipmentItems);

  // The reference is read and written inside the transaction, so the number it
  // counts from is committed state. Two benches dispatching at the same instant
  // can still land on the same one — the unique index catches that, and the
  // attempt is made again rather than failing a picked pallet over a race.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await createDispatchedShipment(
        { rest, shipmentItems, derivedClientId, actorUserId },
      );
    } catch (error) {
      if (attempt >= REFERENCE_ATTEMPTS || !isReferenceClash(error)) throw error;
    }
  }
};

/**
 * One attempt at the whole thing: number it, write it, take the stock out.
 *
 * One transaction for the whole shipment. Previously the row was written first
 * and each item created in its own transaction, so a later line that could not
 * be reserved returned 400 while leaving the shipment, the earlier items, and
 * their stock reservations behind. The caller saw a failure and assumed nothing
 * had happened, and that stock stayed reserved against a shipment nobody would
 * ever pick or cancel.
 */
const createDispatchedShipment = async ({
  rest,
  shipmentItems,
  derivedClientId,
  actorUserId,
}) => {
  return prisma.$transaction(async (tx) => {
    const reference = await nextReference(tx);
    const shipmentData = {
      ...rest,
      reference,
      clientId: derivedClientId,
      createdByUserId: actorUserId,
      status: "DISPATCHED",
    };

    const shipment = await shipmentRepositry.createShipment(shipmentData, tx);

    if (Array.isArray(shipmentItems)) {
      for (const item of shipmentItems) {
        await shipmentItemLogic.createShipmentItem(
          { ...item, shipmentId: shipment.id },
          { tx },
        );
      }
    }

    // Billable services are no longer attached here. They are charged from the
    // Clients screen as a deliberate act, rather than riding along on a
    // shipment where nobody looks for them afterwards.

    // Stock out and the invoice line, in this same transaction: a shipment that
    // exists but never left the shelf is the state this used to allow.
    await applyDispatchEffects({ ...shipment, reference }, actorUserId, tx);

    const createdItems = await shipmentItemLogic.getShipmentItemsByField(
      "shipmentId",
      shipment.id,
      tx,
    );

    return { ...shipment, shipmentItems: createdItems };
  }, {
    maxWait: 10_000,
    timeout: 60_000,
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

    // Prefer whoever is doing the dispatching; fall back to the employee the
    // shipment was created against, for rows written before creators existed.
    const ledgerUserId =
      actorUserId || shipment.createdByUserId || shipment.employee?.userId;

    await applyDispatchEffects(shipment, ledgerUserId, tx);

    return await shipmentRepositry.getShipmentByField("id", shipmentId, tx);
  }, {
    maxWait: 10_000,
    timeout: 60_000,
  });

  await audit(actorUserId, "SHIPMENT_DISPATCHED", {
    shipmentId,
    reference: shipment.reference,
    clientId: shipment.clientId,
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
 * Hard-deletes a shipment.
 *
 * The three statuses need three different reversals, because "delete" means
 * something different once goods have moved:
 *
 *   PENDING / READY_FOR_DISPATCH — the stock is only reserved, never taken off
 *     the shelf. Hand the reservation back and delete the row.
 *   CANCELLED — the reservation was already released when it was cancelled;
 *     nothing to undo, just delete.
 *   DISPATCHED — the goods physically left: the shelf was decremented and the
 *     client was charged. Deleting has to put both back. For each line we return
 *     the still-outstanding quantity (what a partial return has not already put
 *     back) to its source bin as a RETURN movement, then remove the shipment's
 *     invoice line and recompute the invoice.
 *
 * Deleting a dispatched shipment was refused until this — the reasoning was that
 * the ledger rows reference it. They still do, and deliberately: the CHECKOUT
 * and the reversing RETURN both carry the shipment reference, so the movement
 * history survives the row and reads as a matched pair. What is refused now is
 * narrower and correct: a shipment whose invoice has already been PAID, because
 * money that has changed hands is reversed with a credit note, not by deleting
 * the record of what it was for.
 */
/**
 * What a delete would refuse on, and what it would undo, for the warning shown
 * before it. See utils/dependents.js for what blocking and removedWith mean.
 *
 * Blocking:
 *  - a charge on a PAID invoice — the same refusal deleteShipment has always
 *    made, now said before the button rather than after
 *  - any return against it, of either kind. A return is physical proof the
 *    parcel went out, and it carries charges of its own. Deleting the shipment
 *    under it took the dispatch charge off the invoice while leaving the
 *    return charges on, unlinked — billing a client for goods coming back
 *    from a shipment that, on the record, never left. Returns are deleted
 *    first, then the shipment.
 *
 * Removed with it: the lines and attached services, the stock that goes back
 * on the shelf (or the reservation handed back, before dispatch), and the
 * charge lines on unpaid invoices, which are recomputed.
 */
const getShipmentDependents = async (id, tx) => {
  const db = tx ?? prisma;
  const shipment = await requireShipment(id, tx);
  const dispatched = shipment.status === "DISPATCHED";

  const [items, services, returns, chargeLines] = await Promise.all([
    db.shipmentItem.findMany({
      where: { shipmentId: id },
      select: { quantity: true, returnedQuantity: true },
    }),
    db.shipmentServiceMapping.count({ where: { shipmentId: id } }),
    db.productReturn.findMany({
      where: { shipmentId: id },
      select: { quantity: true, shipmentItemId: true },
    }),
    dispatched
      ? db.invoiceLineItem.findMany({
          where: { shipmentId: id, itemType: "SHIPMENT_CHARGE" },
          select: { invoice: { select: { status: true } } },
        })
      : [],
  ]);

  const paidCharges = chargeLines.filter((line) => line.invoice?.status === "PAID").length;

  // Every return adds to a line's returnedQuantity. What the line counts beyond
  // its return records came back through the line's Return button before it
  // booked records (see undoLineReturns), and has no record of its own.
  const returnedOnLines = items.reduce((sum, item) => sum + (item.returnedQuantity ?? 0), 0);
  const returnedViaRecords = returns
    .filter((r) => r.shipmentItemId)
    .reduce((sum, r) => sum + r.quantity, 0);
  const returnedViaLines = Math.max(0, returnedOnLines - returnedViaRecords);
  // A cancelled shipment already handed its reservation back.
  const unitsBack =
    shipment.status === "CANCELLED"
      ? 0
      : items.reduce(
          (sum, item) =>
            sum + (dispatched ? item.quantity - (item.returnedQuantity ?? 0) : item.quantity),
          0,
        );

  return {
    shipment,
    report: buildReport({
      blocking: [
        {
          key: "paidInvoice",
          label: "Charges on a paid invoice",
          count: paidCharges,
          where: "/invoices",
          note: "Money has changed hands. Raise a credit note on that invoice instead.",
        },
        {
          key: "returns",
          label: "Returns recorded against it",
          count: returns.length,
          where: "/returns",
          note: "Delete those returns first.",
        },
        {
          key: "lineReturns",
          label: "Units returned from its lines",
          count: returnedViaLines,
          note: "Returned with the line return button before it recorded returns. Undo them from the shipment's details.",
        },
      ],
      removedWith: [
        { key: "items", label: "Shipment lines", count: items.length },
        {
          key: "units",
          label: dispatched ? "Units put back on their shelves" : "Reserved units released",
          count: unitsBack,
        },
        {
          key: "charges",
          label: "Charges taken off unpaid invoices",
          count: chargeLines.length - paidCharges,
          where: "/invoices",
        },
        { key: "services", label: "Billable services attached", count: services },
      ],
    }),
  };
};

const deleteShipment = async (id, actorUserId) => {
  if (!actorUserId) {
    throw new Error("An authenticated user is required to delete a shipment.");
  }

  const { shipment, reversal } = await prisma.$transaction(
    async (tx) => {
      // Locked, then checked: a dispatch landing between a check and this
      // would otherwise be deleted as the undispatched shipment it was, with
      // its goods never put back.
      await lockForDelete(tx, "shipments", id);
      const { shipment, report } = await getShipmentDependents(id, tx);
      assertDeletable(`Shipment ${shipment.reference}`, report);

      const shipmentItems = await tx.shipmentItem.findMany({
        where: { shipmentId: id },
      });

      if (shipment.status === "DISPATCHED") {
        return {
          shipment,
          reversal: await reverseDispatchedShipment(shipment, shipmentItems, actorUserId, tx),
        };
      }

      // Not dispatched: nothing left the shelf. A cancelled shipment already
      // handed its reservation back; anything else still holds one.
      if (shipment.status !== "CANCELLED") {
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

      await shipmentRepositry.deleteShipment(id, tx);
      return { shipment, reversal: { restored: [], chargeRemoved: false } };
    },
    {
      maxWait: 10_000,
      timeout: 30_000,
    },
  );

  // The dispatch charge came off an invoice that may be APPROVED; its PDF must
  // follow. invoiceIds is split off so it does not leak into the audit details.
  const { invoiceIds, ...reversalDetails } = reversal;
  await syncInvoicePdfs(invoiceIds, actorUserId);

  await audit(
    actorUserId,
    shipment.status === "DISPATCHED" ? "SHIPMENT_DELETED_DISPATCHED" : "SHIPMENT_DELETED",
    {
      shipmentId: id,
      reference: shipment.reference,
      status: shipment.status,
      clientId: shipment.clientId,
      ...(shipment.status === "DISPATCHED" ? reversalDetails : {}),
    },
  );

  return { id };
};

/**
 * The DISPATCHED branch of deleteShipment, kept separate because it is the only
 * one that moves stock and money.
 *
 * Runs entirely inside the caller's transaction. Order matters: the invoice
 * check happens first, so a PAID invoice aborts before any stock is written and
 * the whole transaction rolls back untouched.
 */
const reverseDispatchedShipment = async (shipment, shipmentItems, actorUserId, tx) => {
  // The charge this shipment raised at dispatch, found by the backlink rather
  // than by its description. Zero lines when the client had no dispatch rate —
  // the goods still moved, they just were not billed.
  const chargeLines = await tx.invoiceLineItem.findMany({
    where: { shipmentId: shipment.id, itemType: "SHIPMENT_CHARGE" },
    include: { invoice: { select: { id: true, status: true } } },
  });

  const paid = chargeLines.find((line) => line.invoice?.status === "PAID");
  if (paid) {
    throw new Error(
      "This shipment's invoice has already been paid, so it cannot be deleted — raise a credit note against that invoice instead.",
    );
  }

  // Put the outstanding quantity of each line back on its source shelf. A
  // shipment with any return is refused before this point (see
  // getShipmentDependents), so returnedQuantity is zero here in practice; the
  // subtraction stays so a return slipping in between the check and this
  // transaction cannot be put back twice. The ledger applies the stock change;
  // RETURN adds to current_quantity the same way CHECKOUT took it away.
  const restored = [];
  for (const item of shipmentItems) {
    const outstanding = item.quantity - (item.returnedQuantity ?? 0);
    if (outstanding <= 0) continue;

    await inventoryLedgerLogic.createInventoryLedger(
      {
        productId: item.productId,
        userId: actorUserId,
        movementType: "RETURN",
        quantity: outstanding,
        toLocationId: item.sourceLocationId,
        // The same reference the CHECKOUT carried, so the reversal and the
        // dispatch it undoes read as a pair in the ledger after the row is gone.
        referenceId: shipment.reference,
        notes: `Reversed on deletion of shipment ${shipment.reference}`,
      },
      { tx },
    );
    restored.push({ productId: item.productId, quantity: outstanding });
  }

  // Remove the charge and recompute the invoices it touched. Recomputed per
  // invoice id in case a future change ever splits a shipment's charge across
  // more than one.
  const affectedInvoiceIds = new Set(chargeLines.map((line) => line.invoiceId));
  for (const line of chargeLines) {
    await invoiceLineItemRepository.deleteInvoiceLineItem(line.id, tx);
  }
  for (const invoiceId of affectedInvoiceIds) {
    await monthlyInvoiceRepository.recalculateInvoiceTotal(invoiceId, tx);
  }

  // The row last, so every reversing movement above was written while the
  // shipment it references still existed. Items cascade.
  await shipmentRepositry.deleteShipment(shipment.id, tx);

  return {
    restored,
    chargeRemoved: chargeLines.length > 0,
    invoiceIds: [...affectedInvoiceIds],
  };
};

// ─── Undoing the returns booked on a shipment's lines ────────────────────────
//
// Before every return was a record, the line's Return button only bumped the
// line's returnedQuantity, moved the stock and optionally raised a charge. It
// books a return record now (product_return.logic recordLineReturn), so what is
// undone here is only what it booked before that change.

/**
 * What the old line return button booked on each line: its returnedQuantity,
 * less what return records account for (those are deleted from the Returns
 * screen). Only lines with something to undo.
 */
const lineReturnsOn = async (shipmentId, tx) => {
  const client = tx || prisma;
  const [items, records] = await Promise.all([
    client.shipmentItem.findMany({
      where: { shipmentId, returnedQuantity: { gt: 0 } },
      select: {
        id: true,
        productId: true,
        sourceLocationId: true,
        returnedQuantity: true,
        sourceLocation: { select: { locationName: true, materializedPath: true } },
      },
    }),
    client.productReturn.groupBy({
      by: ["shipmentItemId"],
      where: { shipmentId, shipmentItemId: { not: null } },
      _sum: { quantity: true },
    }),
  ]);
  const viaRecords = new Map(records.map((r) => [r.shipmentItemId, r._sum.quantity ?? 0]));
  return items
    .map((item) => ({
      ...item,
      quantity: Math.max(0, item.returnedQuantity - (viaRecords.get(item.id) ?? 0)),
    }))
    .filter((item) => item.quantity > 0);
};

/**
 * How the old line return button described its charge. Only MANUAL_CHARGE lines
 * on the shipment starting with this are swept up, so manual charges attached
 * some other way never are. Linked to the shipment by migration
 * 20261002110000_link_line_return_charges.
 */
const LEGACY_LINE_RETURN_CHARGE_PREFIX = "Return handling — ";

/** The return-handling charges the old line return button raised for this shipment. */
const lineReturnCharges = (shipmentId, tx) =>
  (tx || prisma).invoiceLineItem.findMany({
    where: {
      shipmentId,
      itemType: "MANUAL_CHARGE",
      description: { startsWith: LEGACY_LINE_RETURN_CHARGE_PREFIX },
    },
    include: { invoice: { select: { status: true } } },
  });

/**
 * What undoing a shipment's line returns would refuse on, and what it undoes.
 *
 * The line return button leaves no record of its own — a count on the line, a
 * RETURN movement, and optionally a charge — so these are undone together, per
 * shipment, rather than one by one: there is nothing that tells two returns on
 * the same line apart. A partial return that was right can be booked again.
 *
 * Blocking, as for a return record: a charge on a paid invoice, and units that
 * are no longer free in the bin they went back to.
 */
const getLineReturnDependents = async (id, tx) => {
  const shipment = await requireShipment(id, tx);
  const [lines, charges] = await Promise.all([lineReturnsOn(id, tx), lineReturnCharges(id, tx)]);

  // Two lines can share a product and a bin; the shelf has to cover both.
  const wanted = new Map();
  for (const line of lines) {
    const key = `${line.productId}|${line.sourceLocationId}`;
    wanted.set(key, (wanted.get(key) ?? 0) + line.quantity);
  }
  let shortfall = 0;
  for (const [key, quantity] of wanted) {
    const [productId, locationId] = key.split("|");
    shortfall += Math.max(0, quantity - (await freeUnitsIn(productId, locationId, tx)));
  }

  const paid = paidAmong(charges).length;
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);

  return {
    shipment,
    lines,
    charges,
    report: buildReport({
      blocking: [
        {
          key: "paidInvoice",
          label: "Return charges on a paid invoice",
          count: paid,
          where: "/invoices",
          note: "Money has changed hands. Raise a credit note on that invoice instead.",
        },
        {
          key: "stockGone",
          label: "Returned units no longer free on the shelf",
          count: shortfall,
          where: "/inventory",
          note: "They have been reserved, picked or moved since they came back.",
        },
      ],
      removedWith: [
        { key: "units", label: "Units taken back off their shelves", count: units },
        {
          key: "charges",
          label: "Return charges taken off unpaid invoices",
          count: charges.length - paid,
          where: "/invoices",
        },
      ],
    }),
  };
};

/**
 * Undoes every return booked with the line return button on a shipment: the
 * units come back off the bins they were put into, each line counts them as
 * out again, and the return charges come off unpaid invoices.
 *
 * Returns booked on the Returns screen are untouched — they are records, and
 * are deleted there.
 */
const undoLineReturns = async (id, actorUserId) => {
  if (!actorUserId) {
    throw new Error("An authenticated user is required to undo returns.");
  }
  const { shipment, undone, invoiceIds } = await prisma.$transaction(
    async (tx) => {
      // Checked under the lock, as deleteShipment is.
      await lockForDelete(tx, "shipments", id);
      const { shipment, lines, charges, report } = await getLineReturnDependents(id, tx);
      if (lines.length === 0) {
        throw new Error(`Nothing was returned with the line return button on ${shipment.reference}.`);
      }
      assertDeletable(`Shipment ${shipment.reference}`, report);

      for (const line of lines) {
        const { count } = await tx.shipmentItem.updateMany({
          where: { id: line.id, returnedQuantity: { gte: line.quantity } },
          data: { returnedQuantity: { decrement: line.quantity } },
        });
        if (count === 0) {
          throw new Error("A line's returns changed while this was being undone. Try again.");
        }
        await takeOffShelf(
          {
            productId: line.productId,
            locationId: line.sourceLocationId,
            quantity: line.quantity,
            // The shipment reference, as on the RETURN this reverses.
            reference: shipment.reference,
            notes: `Line return on ${shipment.reference} undone`,
            actorUserId,
          },
          tx,
        );
      }

      const invoiceIds = await removeChargeLines(charges, tx);
      return {
        shipment,
        undone: {
          lines: lines.map((line) => ({ shipmentItemId: line.id, quantity: line.quantity })),
          chargesRemoved: charges.length,
        },
        invoiceIds,
      };
    },
    { maxWait: 10_000, timeout: 30_000 },
  );

  await syncInvoicePdfs(invoiceIds, actorUserId);

  await audit(actorUserId, "SHIPMENT_LINE_RETURNS_UNDONE", {
    shipmentId: shipment.id,
    reference: shipment.reference,
    clientId: shipment.clientId,
    ...undone,
  });

  return { id: shipment.id, ...undone };
};

module.exports = {
  getLineReturnDependents,
  undoLineReturns,
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
  getShipmentDependents,
  deleteShipment,
  // Exported for tests and for the item logic's own guards.
  SHIPMENT_TRANSITIONS,
  SHIPMENT_STATUSES,
  assertTransition,
  normaliseTrackingId,
};
