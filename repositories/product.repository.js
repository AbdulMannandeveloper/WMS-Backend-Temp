const { prisma } = require('../lib/prisma');

const prismaProduct = prisma.product;

const createProduct = async (productData) => {
  return await prismaProduct.create({
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
  getProductByField,
  getProductById,
  updateProduct,
  deleteProduct,
};
