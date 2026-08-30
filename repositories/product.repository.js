const { prisma } = require('../lib/prisma');

const prismaProduct = prisma.product;

// Pass `tx` to join an interactive transaction (e.g. create product + opening stock).
const db = (tx) => (tx ? tx.product : prismaProduct);

const createProduct = async (productData, tx) => {
  return await db(tx).create({
    data: productData,
    include: { client: true },
  });
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
    where: { [field]: value },
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
    where: { [field]: value },
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

const getProductByField = async (field, value) => {
  return await prismaProduct.findFirst({
    where: { [field]: value },
    include: {
      client: true,
    },
  });
};

const getProductById = async (id) => {
  return await prismaProduct.findUnique({
    where: { id },
    include: {
      client: true,
    },
  });
};

const updateProduct = async (id, updateData) => {
  return await prismaProduct.update({
    where: { id },
    data: updateData,
    include: { client: true },
  });
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
