const { prisma } = require('../lib/prisma');
const { normaliseCode, equalsIgnoringCase } = require('../utils/identifiers');

const prismaProduct = prisma.product;

// Pass `tx` to join an interactive transaction (e.g. create product + opening stock).
const db = (tx) => (tx ? tx.product : prismaProduct);

// SKU and barcode keep the case they were entered in but are matched without
// it (utils/identifiers.js), and the database refuses two that differ only in
// case. Both halves live here so every caller — the product form, goods-in,
// the scanner — gets the same answer.
const CODE_FIELDS = ['skuCode', 'barcode'];

const normaliseCodes = (data) => {
  const out = { ...data };
  for (const field of CODE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(out, field)) {
      out[field] = normaliseCode(out[field]);
    }
  }
  return out;
};

const whereField = (field, value) =>
  CODE_FIELDS.includes(field) && typeof value === 'string'
    ? { [field]: equalsIgnoringCase(normaliseCode(value) ?? '') }
    : { [field]: value };

/**
 * Says which code is taken, instead of Prisma's constraint dump.
 *
 * The case-insensitive indexes report their target as `lower(sku_code::text)`,
 * the exact ones as `sku_code`; either way the column name is in there.
 */
const explainClash = (err) => {
  if (err?.code !== 'P2002') return err;
  const target = err.meta?.target;
  const fields = (Array.isArray(target) ? target : [target]).map((f) => String(f ?? ''));
  if (fields.some((f) => f.includes('sku'))) {
    return new Error('That client already has a product with this SKU (letter case is ignored).');
  }
  if (fields.some((f) => f.includes('barcode'))) {
    return new Error('That barcode is already assigned to another product (letter case is ignored).');
  }
  return err;
};

const createProduct = async (productData, tx) => {
  try {
    return await db(tx).create({
      data: normaliseCodes(productData),
      include: { client: true },
    });
  } catch (err) {
    throw explainClash(err);
  }
};

const getAllProducts = async () => {
  return await prismaProduct.findMany({
    include: {
      client: true,
    },
  });
};

const getProductsByField = async (field, value) => {
  return await prismaProduct.findMany({
    where: whereField(field, value),
    include: {
      client: true,
    },
  });
};

/**
 * Products matching a field, with enough context for a scan result to be acted
 * on without a second round trip: which client owns it, and how much sits where.
 *
 * Separate from getProductsByField because that one feeds list views, and stock
 * levels would bloat every one of them.
 */
const getProductsByFieldWithStock = async (field, value, tx) => {
  return await (tx || prisma).product.findMany({
    where: whereField(field, value),
    include: {
      client: { select: { id: true, companyName: true } },
      stockLevels: {
        include: {
          location: { select: { id: true, locationName: true, materializedPath: true } },
        },
      },
    },
    orderBy: { skuCode: "asc" },
  });
};

/**
 * `tx` matters here, not just for tidiness. The ledger validates that a product
 * exists before writing a movement for it, and goods-in creates the product and
 * its first CHECKIN inside one transaction. Reading outside that transaction
 * cannot see the product that was created a moment earlier, so the movement is
 * refused with "Provided product not found."
 */
const getProductByField = async (field, value, tx) => {
  return await db(tx).findFirst({
    where: whereField(field, value),
    include: {
      client: true,
    },
  });
};

const getProductById = async (id, tx) => {
  return await db(tx).findUnique({
    where: { id },
    include: {
      client: true,
    },
  });
};

const updateProduct = async (id, updateData) => {
  try {
    return await prismaProduct.update({
      where: { id },
      data: normaliseCodes(updateData),
      include: { client: true },
    });
  } catch (err) {
    throw explainClash(err);
  }
};

const deleteProduct = async (id) => {
  return await prismaProduct.delete({
    where: { id },
  });
};

module.exports = {
  createProduct,
  getAllProducts,
  getProductsByField,
  getProductsByFieldWithStock,
  getProductByField,
  getProductById,
  updateProduct,
  deleteProduct,
};
