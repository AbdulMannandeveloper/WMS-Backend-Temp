const { prisma } = require("../lib/prisma");
const {
  dateRangeFilter,
  parseEnum,
  parseString,
  parseUuid,
  searchFilter,
} = require("../utils/queryFilters");
const inventoryLedgerRepository = require("../repositories/inventory_ledger.repository");
const productRepository = require("../repositories/product.repository");
const locationRepository = require("../repositories/location.repository");
const userRepository = require("../repositories/user.repository");
const stockLevelRepository = require("../repositories/stock_level.repository");
const shipmentRepository = require("../repositories/shipment.repository");

const validateLedgerInput = async (newData, tx) => {
  if (
    !newData.productId ||
    !newData.userId ||
    !newData.movementType ||
    !newData.quantity
  ) {
    throw new Error(
      "Product ID, user ID, movement type, and quantity are required to create an inventory ledger entry.",
    );
  }

  // tx, so a product created earlier in this same transaction is visible.
  const product = await productRepository.getProductByField(
    "id",
    newData.productId,
    tx,
  );
  if (!product) {
    throw new Error(`Provided product not found.`);
  }

  if (newData.quantity <= 0) {
    throw new Error("Quantity must be a positive number.");
  }

  if (newData.movementType === "CHECKOUT") {
    if (!newData.referenceId) {
      throw new Error(
        "Reference ID is required for CHECKOUT movements to link the inventory movement to a specific shipment or order.",
      );
    }
    // Looked up by `reference` — the label scanned off the parcel — because that
    // is what the ledger now stores. It is unique, it is what is printed on the
    // paperwork, and it is what somebody reading a movement can act on; the
    // uuid told them nothing.
    //
    // A reference belongs to either an outbound Shipment (SHP-…) or a bulk
    // shipment (BULK-…, held on FbaShipment): both take goods off the shelf and
    // both bill on dispatch, so a CHECKOUT may reference either. The outbound
    // table is tried first, then the bulk one; whichever is found must be
    // DISPATCHED before its stock can move.
    const client = tx || null;
    const shipment = client
      ? await client.shipment.findFirst({ where: { reference: newData.referenceId } })
      : await shipmentRepository.getShipmentByField(
          "reference",
          newData.referenceId,
        );
    const source =
      shipment ||
      (client
        ? await client.fbaShipment.findFirst({ where: { reference: newData.referenceId } })
        : await prisma.fbaShipment.findFirst({ where: { reference: newData.referenceId } }));
    if (!source) {
      throw new Error(`Provided shipment not found.`);
    }
    if (source.status !== "DISPATCHED") {
      throw new Error(
        `Shipment must be in DISPATCHED status to be referenced in a checkout movement.`,
      );
    }
  }

  // A write-off with no reason is not an audit trail — it is stock that
  // vanished. This is the one movement type nothing else corroborates: a
  // CHECKOUT has a shipment, a CHECKIN has a delivery, an INTERNAL_MOVE has a
  // destination. An ADJUSTMENT has only what the operator typed.
  if (newData.movementType === "ADJUSTMENT") {
    if (!newData.notes || !String(newData.notes).trim()) {
      throw new Error(
        "A reason is required to write stock off — say what happened to it.",
      );
    }
  }

  const movementRequirements = {
    CHECKIN: { requireFrom: false, requireTo: true },
    INTERNAL_MOVE: { requireFrom: true, requireTo: true },
    CHECKOUT: { requireFrom: true, requireTo: false },
    // Goods coming back after dispatch. Same shape as a CHECKIN — they arrive
    // into a bin from outside — but a distinct type, because a customer return
    // and a supplier delivery are different events and folding them together
    // makes every goods-in figure wrong.
    RETURN: { requireFrom: false, requireTo: true },
    // Off the shelf and out of the count. Names a bin, never a shipment.
    ADJUSTMENT: { requireFrom: true, requireTo: false },
  };

  const req = movementRequirements[newData.movementType];
  if (!req) {
    throw new Error(`Unknown movement type: ${newData.movementType}`);
  }

  if (req.requireEither) {
    if (!newData.fromLocationId && !newData.toLocationId) {
      throw new Error(
        "At least one of fromLocationId or toLocationId is required for this movement type.",
      );
    }
  } else {
    if (req.requireFrom && !newData.fromLocationId) {
      throw new Error("fromLocationId is required for this movement type.");
    }
    if (req.requireTo && !newData.toLocationId) {
      throw new Error("toLocationId is required for this movement type.");
    }
  }

  if (newData.fromLocationId) {
    const fromLocation = await locationRepository.getLocationByField(
      "id",
      newData.fromLocationId,
    );
    if (!fromLocation) {
      throw new Error(`Provided from location not found.`);
    }
  }
  if (newData.toLocationId) {
    const toLocation = await locationRepository.getLocationByField(
      "id",
      newData.toLocationId,
    );
    if (!toLocation) {
      throw new Error(`Provided to location not found.`);
    }
  }
};

/**
 * Adjust stock levels based on a ledger entry using atomic conditional updates.
 * Runs inside the caller's transaction client.
 */
const adjustStockLevels = async (ledgerEntry, tx) => {
  if (ledgerEntry.movementType === "CHECKIN") {
    await stockLevelRepository.increaseOrCreateStockAtomically(
      ledgerEntry.productId,
      ledgerEntry.toLocationId,
      ledgerEntry.quantity,
      tx,
      { countAsArrival: true },
    );
    return true;
  }

  if (ledgerEntry.movementType === "RETURN") {
    // Back onto the shelf. Same shape as a CHECKIN, but deliberately NOT
    // counted as an arrival: arrivedTodayQuantity drives the goods-in view, and
    // a customer return is not a delivery.
    await stockLevelRepository.increaseOrCreateStockAtomically(
      ledgerEntry.productId,
      ledgerEntry.toLocationId,
      ledgerEntry.quantity,
      tx,
      { countAsArrival: false },
    );
    return true;
  }

  if (ledgerEntry.movementType === "CHECKOUT") {
    const updated = await stockLevelRepository.checkoutStockAtomically(
      ledgerEntry.productId,
      ledgerEntry.fromLocationId,
      ledgerEntry.quantity,
      tx,
    );
    if (updated === 0) {
      throw new Error(
        `Insufficient reserved/current stock at the from location to perform the CHECKOUT movement.`,
      );
    }
    return true;
  }

  if (ledgerEntry.movementType === "ADJUSTMENT") {
    // The from-side of an INTERNAL_MOVE with nowhere to land. Deliberately
    // decreaseAvailable rather than checkout: that helper subtracts only from
    // the non-reserved part, so units already committed to a shipment cannot be
    // written off out from under it. Somebody would be picking them tomorrow.
    const decreased = await stockLevelRepository.decreaseAvailableStockAtomically(
      ledgerEntry.productId,
      ledgerEntry.fromLocationId,
      ledgerEntry.quantity,
      tx,
    );
    if (decreased === 0) {
      throw new Error(
        `Cannot write off ${ledgerEntry.quantity} — that is more than the available (unreserved) stock at this location.`,
      );
    }
    return true;
  }

  if (ledgerEntry.movementType === "INTERNAL_MOVE") {
    const decreased = await stockLevelRepository.decreaseAvailableStockAtomically(
      ledgerEntry.productId,
      ledgerEntry.fromLocationId,
      ledgerEntry.quantity,
      tx,
    );
    if (decreased === 0) {
      throw new Error(
        `Cannot perform the INTERNAL_MOVE movement because the quantity exceeds the available stock at the from location.`,
      );
    }
    await stockLevelRepository.increaseOrCreateStockAtomically(
      ledgerEntry.productId,
      ledgerEntry.toLocationId,
      ledgerEntry.quantity,
      tx,
    );
    return true;
  }

  throw new Error(`Unsupported movement type: ${ledgerEntry.movementType}`);
};

/**
 * Create ledger + adjust stock in a single atomic transaction.
 * Pass `{ tx }` to join an outer interactive transaction (e.g. dispatch).
 */
const createInventoryLedger = async (newData, options = {}) => {
  const run = async (tx) => {
    await validateLedgerInput(newData, tx);
    const inventoryLedgerEntry =
      await inventoryLedgerRepository.createInventoryLedger(newData, tx);
    await adjustStockLevels(inventoryLedgerEntry, tx);
    return inventoryLedgerEntry;
  };

  if (options.tx) {
    return run(options.tx);
  }

  return prisma.$transaction(async (tx) => run(tx), {
    maxWait: 10_000,
    timeout: 30_000,
  });
};

const MOVEMENT_TYPES = [
  "CHECKIN",
  "INTERNAL_MOVE",
  "CHECKOUT",
  "RETURN",
  "ADJUSTMENT",
];

/** What the ledger may be narrowed by. Shared with /summary. */
const INVENTORY_LEDGER_LIST_SPEC = {
  filters: [
    (q) => searchFilter(q.search, [
      "product.skuCode",
      "product.productName",
      "referenceId",
      "notes",
    ]),
    (q) => {
      const productId = parseUuid(q.productId, "productId");
      return productId ? { productId } : undefined;
    },
    (q) => {
      const userId = parseUuid(q.userId, "userId");
      return userId ? { userId } : undefined;
    },
    (q) => {
      const movementType = parseEnum(q.movementType, MOVEMENT_TYPES, {
        label: "movementType",
      });
      return movementType ? { movementType } : undefined;
    },
    (q) => {
      const referenceId = parseString(q.referenceId, { label: "referenceId", maxLength: 100 });
      return referenceId ? { referenceId } : undefined;
    },
    (q) => {
      const fromLocationId = parseUuid(q.fromLocationId, "fromLocationId");
      return fromLocationId ? { fromLocationId } : undefined;
    },
    (q) => {
      const toLocationId = parseUuid(q.toLocationId, "toLocationId");
      return toLocationId ? { toLocationId } : undefined;
    },
    (q) => {
      // timestamp is @db.Timestamptz, so the end bound carries to the last
      // instant of the day — built in UTC, unlike the local setHours this
      // replaces, which moved the boundary by the server timezone.
      const range = dateRangeFilter(q.startDate, q.endDate, { granularity: "timestamp" });
      return range ? { timestamp: range } : undefined;
    },
  ],
  sort: {
    allowed: {
      timestamp: (order) => ({ timestamp: order }),
      quantity: (order) => ({ quantity: order }),
      movementType: (order) => ({ movementType: order }),
      productName: (order) => ({ product: { productName: order } }),
    },
    defaultSort: { field: "timestamp", order: "desc" },
    tiebreaker: [{ id: "asc" }],
  },
};

/**
 * Narrowing to one client.
 *
 * A relation filter, not a list of product ids. The previous shape read every
 * product a client owns and put them in an IN clause — unbounded, one extra
 * query, and it overwrote any productId filter already set because both wrote
 * the same key. This composes instead, and rides the products client_id index.
 */
const clientScopeClause = (clientId) => ({ product: { clientId } });

const getAllInventoryLedgers = async (where, options) =>
  await inventoryLedgerRepository.getAllInventoryLedgers(where, options);

const summariseInventoryLedgers = async (where) =>
  await inventoryLedgerRepository.summariseInventoryLedgers(where);

const getInventoryLedgerByField = async (field, value) => {
  return await inventoryLedgerRepository.getInventoryLedgerByField(field, value);
};

/**
 * The loose-filter form, kept for internal callers.
 *
 * product.logic reads a product recent-movements list through this with a
 * hand-built { skip, take }, so the signature stays. Every clause is now
 * composed with AND rather than written into one object: productId and clientId
 * used to collide on the same key, and whichever ran last silently won.
 */
const getLedgerWithFilters = async (
  { startDate, endDate, productId, clientId, movementType } = {},
  pagination,
) => {
  const clauses = [];

  const range = dateRangeFilter(startDate, endDate, { granularity: "timestamp" });
  if (range) clauses.push({ timestamp: range });
  if (productId) clauses.push({ productId });
  if (movementType) clauses.push({ movementType });
  if (clientId) clauses.push(clientScopeClause(clientId));

  const where =
    clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { AND: clauses };

  return await inventoryLedgerRepository.getAllInventoryLedgers(where, { pagination });
};

/**
 * One client, through the relation rather than a materialised id list.
 *
 * The empty-client special case is gone with it: a relation filter over a
 * client with no products simply matches nothing, which is the same answer
 * without the extra read.
 */
const getInventoryLedgersByClientId = async (clientId, where = {}, options = {}) =>
  await inventoryLedgerRepository.getAllInventoryLedgers(
    { AND: [where, clientScopeClause(clientId)] },
    options,
  );

const getDailyCheckoutSummary = async ({ startDate, endDate, clientId } = {}) => {
  const rangeStart = startDate ? new Date(startDate) : new Date();
  // A single date still works: leaving endDate off closes the range on the day
  // it opened, which is what the summary meant before it took a range at all.
  const rangeEnd = endDate ? new Date(endDate) : new Date(rangeStart);
  rangeStart.setHours(0, 0, 0, 0);
  rangeEnd.setHours(23, 59, 59, 999);

  const result = await inventoryLedgerRepository.getAllInventoryLedgers({
    movementType: "CHECKOUT",
    timestamp: { gte: rangeStart, lte: rangeEnd },
  });
  const checkouts = Array.isArray(result) ? result : result.items;

  const grouped = {};
  for (const entry of checkouts) {
    const clientId = entry.product?.client?.id || "unknown";
    const companyName = entry.product?.client?.companyName || "Unknown Client";

    if (!grouped[clientId]) {
      grouped[clientId] = {
        clientId,
        companyName,
        totalItemsCheckedOut: 0,
        items: [],
      };
    }

    grouped[clientId].totalItemsCheckedOut += entry.quantity;
    grouped[clientId].items.push({
      ledgerId: entry.id,
      productId: entry.productId,
      productName: entry.product?.productName || "Unknown",
      skuCode: entry.product?.skuCode || null,
      quantity: entry.quantity,
      fromLocation: entry.fromLocation?.locationName || null,
      performedBy: entry.user
        ? `${entry.user.firstName} ${entry.user.lastName}`
        : "Unknown",
      timestamp: entry.timestamp,
      shipmentId: entry.referenceId || null,
    });
  }

  const groups = Object.values(grouped);
  return clientId ? groups.filter((g) => g.clientId === clientId) : groups;
};

// Unused enrichment helpers kept for potential future use
const enrichLedgerEntriesWithProductDetails = async (ledgers) => {
  for (const ledger of ledgers) {
    const product = await productRepository.getProductByField(
      "id",
      ledger.productId,
    );
    ledger.productName = product ? product.name : "Unknown Product";
  }
  return ledgers;
};

const enrichLedgerEntriesWithLocationDetails = async (ledgers) => {
  for (const ledger of ledgers) {
    if (ledger.fromLocationId) {
      const fromLocation = await locationRepository.getLocationByField(
        "id",
        ledger.fromLocationId,
      );
      ledger.fromLocationName = fromLocation
        ? fromLocation.name
        : "Unknown Location";
    }
    if (ledger.toLocationId) {
      const toLocation = await locationRepository.getLocationByField(
        "id",
        ledger.toLocationId,
      );
      ledger.toLocationName = toLocation ? toLocation.name : "Unknown Location";
    }
  }
  return ledgers;
};

const enrichLedgerEntriesWithUserDetails = async (ledgers) => {
  for (const ledger of ledgers) {
    const user = await userRepository.getUserByField("id", ledger.userId);
    ledger.userName = user ? user.name : "Unknown User";
  }
  return ledgers;
};

module.exports = {
  INVENTORY_LEDGER_LIST_SPEC,
  clientScopeClause,
  summariseInventoryLedgers,
  createInventoryLedger,
  getAllInventoryLedgers,
  getInventoryLedgerByField,
  getInventoryLedgersByClientId,
  getLedgerWithFilters,
  getDailyCheckoutSummary,
  adjustStockLevels,
};
