const { prisma } = require("../lib/prisma");
const { assertAllowedField } = require("../utils/pick");

const prismaWarehouseLocationClass = prisma.warehouseLocationClass;

// The controller hands `field` straight through from the route params, so this
// one is reachable from a request today — unlike its siblings, which are only
// safe because their callers hardcode the column.
const CLASS_QUERY_FIELDS = ["id", "name", "parentClassId"];

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
  assertAllowedField(field, CLASS_QUERY_FIELDS);
  return await prismaWarehouseLocationClass.findMany({
    where: { [field]: value },
  });
};

const getWarehouseLocationClassFirstByField = async (field, value) => {
  assertAllowedField(field, CLASS_QUERY_FIELDS);
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

const deleteWarehouseLocationClass = async (id, tx) => {
  return await (tx ? tx.warehouseLocationClass : prismaWarehouseLocationClass).delete({
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