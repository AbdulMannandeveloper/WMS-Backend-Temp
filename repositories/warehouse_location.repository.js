const { prisma } = require("../lib/prisma");
const { assertAllowedField } = require("../utils/pick");

const prismaWarehouseLocation = prisma.warehouseLocation;

const LOCATION_QUERY_FIELDS = [
  "id",
  "locationName",
  "locationClassId",
  "parentLocationId",
  "materializedPath",
];

const createWarehouseLocation = async (locationData) => {
  return await prismaWarehouseLocation.create({
    data: locationData,
  });
};

const includeRelations = {
  locationClass: {
    include: {
      parentClass: true,
    },
  },
  parentLocation: true,
  childLocations: true,
};

/**
 * @param {object} where - a Prisma where; {} matches everything.
 * @param {object} [options]
 * @param {object[]} [options.orderBy] - ends in a unique key, or pages repeat rows.
 * @param {object} [options.pagination] - absent, the whole set comes back as a
 *   bare array. getWarehouseLocationTree depends on that: it assembles the
 *   parent-child hierarchy from this result, and a page of it would leave
 *   children whose parent is missing, silently orphaned out of the tree.
 */
const getAllWarehouseLocations = async (where = {}, { orderBy, pagination } = {}) => {
  const sort = orderBy || [{ locationName: "asc" }, { id: "asc" }];

  if (pagination && pagination.take != null) {
    const [items, total] = await Promise.all([
      prismaWarehouseLocation.findMany({
        where,
        include: includeRelations,
        orderBy: sort,
        skip: pagination.skip || 0,
        take: pagination.take,
      }),
      prismaWarehouseLocation.count({ where }),
    ]);
    return { items, total };
  }

  return await prismaWarehouseLocation.findMany({
    where,
    include: includeRelations,
    orderBy: sort,
  });
};

/** Totals across the whole filtered set, not the page. */
const summariseWarehouseLocations = async (where = {}) => {
  const [total, byClass] = await Promise.all([
    prismaWarehouseLocation.count({ where }),
    prismaWarehouseLocation.groupBy({
      by: ["locationClassId"],
      where,
      _count: { _all: true },
    }),
  ]);

  const classes = await prisma.warehouseLocationClass.findMany({
    where: { id: { in: byClass.map((row) => row.locationClassId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(classes.map((c) => [c.id, c.name]));

  return {
    total,
    byClass: byClass
      .map((row) => ({
        classId: row.locationClassId,
        name: nameById.get(row.locationClassId) ?? null,
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count),
  };
};

const getWarehouseLocationByField = async (field, value) => {
  assertAllowedField(field, LOCATION_QUERY_FIELDS);
  return await prismaWarehouseLocation.findMany({
    where: { [field]: value },
  });
};

const getWarehouseLocationFirstByField = async (field, value) => {
  assertAllowedField(field, LOCATION_QUERY_FIELDS);
  return await prismaWarehouseLocation.findFirst({
    where: { [field]: value },
    include: {
      locationClass: {
        include: {
          parentClass: true,
        },
      },
      parentLocation: true,
      childLocations: true,
    },
  });
};

const getWarehouseLocationByParentAndName = async (
  parentLocationId,
  locationName,
  excludeId,
) => {
  return await prismaWarehouseLocation.findFirst({
    where: {
      parentLocationId,
      locationName,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
};

const updateWarehouseLocation = async (id, updateData) => {
  return await prismaWarehouseLocation.update({
    where: { id },
    data: updateData,
  });
};

const deleteWarehouseLocation = async (id) => {
  return await prismaWarehouseLocation.delete({
    where: { id },
  });
};

module.exports = {
  summariseWarehouseLocations,
  createWarehouseLocation,
  getAllWarehouseLocations,
  getWarehouseLocationByField,
  getWarehouseLocationFirstByField,
  getWarehouseLocationByParentAndName,
  updateWarehouseLocation,
  deleteWarehouseLocation,
};
