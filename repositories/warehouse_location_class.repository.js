const { prisma } = require("../lib/prisma");

const prismaWarehouseLocationClass = prisma.warehouseLocationClass;

const createWarehouseLocationClass = async (classData) => {
  return await prismaWarehouseLocationClass.create({
    data: classData,
  });
};

const getAllWarehouseLocationClasses = async () => {
  return await prismaWarehouseLocationClass.findMany({
    include: {
      parentClass: true,
      childClasses: true,
    },
  });
};

const getWarehouseLocationClassByField = async (field, value) => {
  return await prismaWarehouseLocationClass.findMany({
    where: { [field]: value },
  });
};

const getWarehouseLocationClassFirstByField = async (field, value) => {
  return await prismaWarehouseLocationClass.findFirst({
    where: { [field]: value },
    include: {
      parentClass: true,
      childClasses: true,
    },
  });
};

const updateWarehouseLocationClass = async (id, updateData) => {
  return await prismaWarehouseLocationClass.update({
    where: { id },
    data: updateData,
  });
};

const deleteWarehouseLocationClass = async (id) => {
  return await prismaWarehouseLocationClass.delete({
    where: { id },
  });
};

module.exports = {
  createWarehouseLocationClass,
  getAllWarehouseLocationClasses,
  getWarehouseLocationClassByField,
  getWarehouseLocationClassFirstByField,
  updateWarehouseLocationClass,
  deleteWarehouseLocationClass,
};