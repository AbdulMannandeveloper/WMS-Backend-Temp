const { prisma } = require("../lib/prisma");
const productRepository = require("../repositories/product.repository");
const inventoryLedgerLogic = require("./inventory_ledger.logic");
const productLogic = require("./product.logic");
const auditLogLogic = require("./audit_log.logic");

/**
 * Goods-in for a whole delivery, in one transaction.
 *
 * A pallet arrives carrying ten different SKUs. Booking those in one request at
 * a time meant the operator watched a modal open and close ten times, and left
 * the door open to a delivery that is half received: six lines committed, line
 * seven rejected, and nobody sure what is actually on the shelf.
 *
 * So the whole basket lands together or not at all. Products that do not exist
 * yet are created inside the same transaction as the movements that fill them,
 * which is why product.repository.getProductByField had to learn about `tx` —
 * the ledger validates the product exists, and outside the transaction it
 * cannot see one created a line earlier.
 *
 * Stock levels are not touched here. createInventoryLedger already adjusts them
 * from the movement it writes, and a second adjustment in this file is exactly
 * how returns ended up double-counting once already.
 */

const MAX_LINES = 200;

/** A line either points at an existing product or carries a new one. */
const isNewProductLine = (line) => Boolean(line && line.newProduct);

const validateBatch = ({ lines, toLocationId }) => {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("Add at least one item before checking the delivery in.");
  }
  if (lines.length > MAX_LINES) {
    throw new Error(
      `A single check-in is limited to ${MAX_LINES} lines. Split the delivery.`,
    );
  }

  lines.forEach((line, i) => {
    const at = `Line ${i + 1}`;

    if (!isNewProductLine(line) && !line.productId) {
      throw new Error(`${at} has neither a product nor new product details.`);
    }

    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`${at} needs a whole quantity above zero.`);
    }

    // Per-line location wins; otherwise the one chosen for the session. One of
    // them has to be there or the movement has nowhere to land.
    if (!line.toLocationId && !toLocationId) {
      throw new Error(`${at} has no destination location.`);
    }
  });
};

/**
 * Refuses a basket that would collide with itself before the database does.
 *
 * Postgres would reject it anyway — products is unique on (client, sku) and on
 * barcode — but it would do so halfway through, and the error it gives names a
 * constraint rather than the two lines that disagree.
 */
const assertNoInternalClashes = (lines) => {
  const seenSku = new Map();
  const seenBarcode = new Map();

  lines.filter(isNewProductLine).forEach((line, i) => {
    const at = `Line ${i + 1}`;
    const { clientId, skuCode, barcode } = line.newProduct;

    const skuKey = `${clientId}::${String(skuCode).trim().toLowerCase()}`;
    if (seenSku.has(skuKey)) {
      throw new Error(
        `${at} repeats SKU ${skuCode} for the same client as line ${seenSku.get(skuKey)}. Combine them into one line.`,
      );
    }
    seenSku.set(skuKey, i + 1);

    if (barcode) {
      const barcodeKey = String(barcode).trim();
      if (seenBarcode.has(barcodeKey)) {
        throw new Error(
          `${at} repeats barcode ${barcode} from line ${seenBarcode.get(barcodeKey)}. Combine them into one line.`,
        );
      }
      seenBarcode.set(barcodeKey, i + 1);
    }
  });
};

/**
 * @param {{ toLocationId?: string, lines: object[], notes?: string }} payload
 * @param {string} actorUserId
 */
const checkInBatch = async (payload, actorUserId) => {
  if (!actorUserId) {
    throw new Error("An authenticated user is required to check stock in.");
  }

  const { lines, toLocationId, notes } = payload || {};
  validateBatch({ lines, toLocationId });
  assertNoInternalClashes(lines);

  // Validated before the transaction opens: a rejected client or a missing SKU
  // should not hold a write lock while it is discovered.
  for (const line of lines.filter(isNewProductLine)) {
    await productLogic.assertProductIsValid(line.newProduct);
  }

  const result = await prisma.$transaction(
    async (tx) => {
      const created = [];

      for (const line of lines) {
        let productId = line.productId;

        if (isNewProductLine(line)) {
          const product = await productRepository.createProduct(
            {
              ...line.newProduct,
              barcode: line.newProduct.barcode || null,
            },
            tx,
          );
          productId = product.id;
          created.push(product);
        }

        await inventoryLedgerLogic.createInventoryLedger(
          {
            productId,
            userId: actorUserId,
            movementType: "CHECKIN",
            quantity: Number(line.quantity),
            toLocationId: line.toLocationId || toLocationId,
            notes: line.notes || notes || "Goods in",
          },
          { tx },
        );
      }

      return { linesReceived: lines.length, productsCreated: created.length };
    },
    // A hundred-line pallet is a lot of round trips; the default 5s is not
    // enough and a timeout here rolls back a delivery someone already unpacked.
    { maxWait: 15_000, timeout: 120_000 },
  );

  // Outside the transaction: an audit write that fails must not undo a delivery
  // that succeeded.
  await auditLogLogic
    .createAuditLog(actorUserId, "CHECKIN_BATCH", {
      linesReceived: result.linesReceived,
      productsCreated: result.productsCreated,
      unitsReceived: lines.reduce((sum, l) => sum + Number(l.quantity), 0),
    })
    .catch((err) => console.error("Audit log error:", err.message));

  return result;
};

module.exports = { checkInBatch, MAX_LINES };
