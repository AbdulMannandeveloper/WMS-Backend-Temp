const { prisma } = require('../lib/prisma');

const prismaProduct = prisma.product;

const createProduct = async (productData) => {
  return await prismaProduct.create({ data: productData });
};

const getAllProducts = async () => {
  return await prismaProduct.findMany();
};

const getProductsByField = async (field, value) => {
  return await prismaProduct.findMany({
    where: { [field]: value },
  });
};

const updateProduct = async (id, updateData) => {
  return await prismaProduct.update({
    where: { id },
    data: updateData,
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
  updateProduct,
  deleteProduct,
};
