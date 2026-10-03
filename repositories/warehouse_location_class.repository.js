const { prisma } = require("../lib/prisma");
const { assertAllowedField } = require("../utils/pick");
const { fieldMatch } = require("../utils/identifiers");

const prismaWarehouseLocationClass = prisma.warehouseLocationClass;

// The controller hands `field` straight through from the route params, so this
// one is reachable from a request today — unlike its siblings, which are only
// safe because their callers hardcode the column.
const CLASS_QUERY_FIELDS = ["id", "name", "parentClassId"];

// `Shelf` and `shelf` are one class; the database agrees (migration
// 20261003140000), so the duplicate check and lookup by name ignore case too.
const CASELESS_FIELDS = ["name"];

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
    where: fieldMatch(field, value, CASELESS_FIELDS),
  });
};

const getWarehouseLocationClassFirstByField = async (field, value) => {
  assertAllowedField(field, CLASS_QUERY_FIELDS);
  return await prismaWarehouseLocationClass.findFirst({
    where: fieldMatch(field, value, CASELESS_FIELDS),
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