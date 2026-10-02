const warehouseLocationRepository = require("../repositories/warehouse_location.repository");
const {
  parseBoolean,
  parseString,
  parseUuid,
  searchFilter,
} = require("../utils/queryFilters");
const warehouseLocationClassRepository = require("../repositories/warehouse_location_class.repository");
const auditLogLogic = require("./audit_log.logic");
const { prisma } = require("../lib/prisma");
const { buildReport, assertDeletable } = require("../utils/dependents");

const createWarehouseLocation = async (locationData) => {
  const locationName = resolveLocationName(locationData);
  if (!locationName) {
    throw new Error("Location name is required");
  }

  const locationClass = await resolveLocationClass(locationData);
  const parentLocationId = locationData.parentLocationId ?? null;
  const parentLocation = await resolveParentLocation(parentLocationId);

  validateParentClass(locationClass, parentLocation);

  const existingLocation =
    await warehouseLocationRepository.getWarehouseLocationByParentAndName(
      parentLocationId,
      locationName,
    );

  if (existingLocation) {
    throw new Error(
      "A location with the same name already exists under the same parent location",
    );
  }

  const createData = buildWarehouseLocationPayload(locationData, {
    locationName,
    locationClassId: locationClass.id,
    parentLocationId,
  });

  createData.materializedPath = createMaterializedPath(
    locationName,
    parentLocation?.materializedPath ?? null,
  );

  return await warehouseLocationRepository.createWarehouseLocation(createData);
};

/**
 * What the location list may be narrowed by.
 *
 * Shared with the /summary handler, which derives its where from this same
 * object and the same req.query.
 */
const WAREHOUSE_LOCATION_LIST_SPEC = {
  filters: [
    (q) => searchFilter(q.search, [
      "locationName",
      "materializedPath",
      "locationClass.name",
    ]),
    (q) => {
      const locationClassId = parseUuid(q.locationClassId, "locationClassId");
      return locationClassId ? { locationClassId } : undefined;
    },
    (q) => {
      // The literal "null" asks for roots. Without it there is no way to say
      // "top of the hierarchy" in a query string, since an absent parameter
      // already means "do not filter".
      const raw = parseString(q.parentLocationId, { label: "parentLocationId", maxLength: 40 });
      if (!raw) return undefined;
      if (raw === "null") return { parentLocationId: null };
      return { parentLocationId: parseUuid(raw, "parentLocationId") };
    },
    (q) => {
      const prefix = parseString(q.pathPrefix, { label: "pathPrefix" });
      return prefix ? { materializedPath: { startsWith: prefix } } : undefined;
    },
    (q) => {
      const hasStock = parseBoolean(q.hasStock, "hasStock");
      if (hasStock === undefined) return undefined;
      return hasStock
        ? { stockLevels: { some: { currentQuantity: { gt: 0 } } } }
        : { stockLevels: { none: { currentQuantity: { gt: 0 } } } };
    },
  ],
  sort: {
    allowed: {
      locationName: (order) => ({ locationName: order }),
      // Nullable, so the empty ones go last either way rather than bubbling to
      // the top of an ascending sort.
      materializedPath: (order) => ({ materializedPath: { sort: order, nulls: "last" } }),
      className: (order) => ({ locationClass: { name: order } }),
    },
    defaultSort: { field: "locationName", order: "asc" },
    tiebreaker: [{ id: "asc" }],
  },
};

const getAllWarehouseLocations = async (where, options) =>
  await warehouseLocationRepository.getAllWarehouseLocations(where, options);

const summariseWarehouseLocations = async (where) =>
  await warehouseLocationRepository.summariseWarehouseLocations(where);

const getWarehouseLocationByField = async (field, value) => {
  return await warehouseLocationRepository.getWarehouseLocationByField(
    field,
    value,
  );
};

const updateWarehouseLocation = async (id, updateData) => {
  const currentLocation =
    await warehouseLocationRepository.getWarehouseLocationFirstByField(
      "id",
      id,
    );

  if (!currentLocation) {
    throw new Error("Warehouse location not found");
  }

  const nextLocationName = resolveLocationName(
    updateData,
    currentLocation.locationName,
  );
  if (!nextLocationName) {
    throw new Error("Location name is required");
  }

  const locationClass = await resolveLocationClass(
    updateData,
    currentLocation.locationClassId,
  );

  const hasParentLocationId = Object.prototype.hasOwnProperty.call(
    updateData,
    "parentLocationId",
  );
  const nextParentLocationId = hasParentLocationId
    ? updateData.parentLocationId
    : currentLocation.parentLocationId;
  const parentLocation = await resolveParentLocation(nextParentLocationId);

  validateParentClass(locationClass, parentLocation);

  if (
    nextLocationName !== currentLocation.locationName ||
    nextParentLocationId !== currentLocation.parentLocationId
  ) {
    const existingLocation =
      await warehouseLocationRepository.getWarehouseLocationByParentAndName(
        nextParentLocationId,
        nextLocationName,
        id,
      );

    if (existingLocation) {
      throw new Error(
        "A location with the same name already exists under the same parent location",
      );
    }
  }

  const updatePayload = buildWarehouseLocationPayload(updateData, {
    locationName: nextLocationName,
    locationClassId: locationClass.id,
    parentLocationId: nextParentLocationId,
  });

  updatePayload.materializedPath = createMaterializedPath(
    nextLocationName,
    parentLocation?.materializedPath ?? null,
  );

  return await warehouseLocationRepository.updateWarehouseLocation(
    id,
    updatePayload,
  );
};

const notFound = (what) => {
  const err = new Error(`${what} not found`);
  err.status = 404;
  return err;
};

/**
 * Everything that still refers to a location, for the warning shown before a
 * delete. See utils/dependents.js for what blocking and removedWith mean.
 *
 * Before this only child locations were checked, and anything else surfaced as
 * a foreign-key error — every relation below is Restrict.
 *
 * Stock movement history is permanent, so a location that has ever held stock
 * stays: it can be renamed, not deleted. Empty stock rows (a product that was
 * here and has all gone) are not history and go with the location.
 */
const getWarehouseLocationDependents = async (id) => {
  const location = await prisma.warehouseLocation.findUnique({ where: { id } });
  if (!location) {
    throw notFound("Location");
  }

  const occupied = {
    locationId: id,
    OR: [{ currentQuantity: { gt: 0 } }, { reservedQuantity: { gt: 0 } }],
  };
  const [children, stocked, emptySlots, shipmentLines, fbaLines, returns, movements] =
    await Promise.all([
      prisma.warehouseLocation.count({ where: { parentLocationId: id } }),
      prisma.stockLevel.count({ where: occupied }),
      prisma.stockLevel.count({ where: { locationId: id, NOT: occupied } }),
      prisma.shipmentItem.count({ where: { sourceLocationId: id } }),
      prisma.fbaShipmentItem.count({ where: { sourceLocationId: id } }),
      prisma.productReturn.count({ where: { restockLocationId: id } }),
      prisma.inventoryLedger.count({
        where: { OR: [{ fromLocationId: id }, { toLocationId: id }] },
      }),
    ]);

  return {
    location,
    report: buildReport({
      blocking: [
        {
          key: "children",
          label: "Locations inside it",
          count: children,
          where: "/warehouse-locations",
          note: "Delete or move those first.",
        },
        {
          key: "stock",
          label: "Products with stock here",
          count: stocked,
          where: "/inventory",
          note: "Move the stock somewhere else first.",
        },
        {
          key: "shipments",
          label: "Shipment lines picked from here",
          count: shipmentLines,
          where: "/shipments",
        },
        {
          key: "fbaShipments",
          label: "Bulk shipment lines picked from here",
          count: fbaLines,
          where: "/fba",
        },
        {
          key: "returns",
          label: "Returns restocked here",
          count: returns,
          where: "/returns",
        },
        {
          key: "ledger",
          label: "Stock movements in or out",
          count: movements,
          note: "Stock history is permanent. Rename this location instead of deleting it.",
        },
      ],
      removedWith: [
        { key: "emptySlots", label: "Empty stock slots", count: emptySlots },
      ],
    }),
  };
};

/**
 * @throws {HasDependentsError} (409) while anything in getWarehouseLocationDependents blocks
 */
const deleteWarehouseLocation = async (id, actorUserId) => {
  const { location, report } = await getWarehouseLocationDependents(id);
  assertDeletable(location.locationName, report);

  await prisma.$transaction(async (tx) => {
    // StockLevel.location is Restrict, so the empty rows have to go first.
    await tx.stockLevel.deleteMany({ where: { locationId: id } });
    await tx.warehouseLocation.delete({ where: { id } });
  });

  if (actorUserId) {
    await auditLogLogic
      .createAuditLog(actorUserId, "DELETE_LOCATION", {
        locationId: id,
        locationName: location.locationName,
        path: location.materializedPath,
      })
      .catch((err) => console.error("Audit log error:", err.message));
  }

  return location;
};

const createWarehouseLocationClass = async (classData) => {
  const className = normalizeText(classData.name);
  if (!className) {
    throw new Error("Location class name is required");
  }

  const parentClassId = classData.parentClassId ?? null;
  const parentClass = parentClassId
    ? await resolveLocationClassById(parentClassId)
    : null;

  if (parentClassId && !parentClass) {
    throw new Error("Parent location class does not exist");
  }

  const existingClass =
    await warehouseLocationClassRepository.getWarehouseLocationClassFirstByField(
      "name",
      className,
    );

  if (existingClass) {
    throw new Error("A location class with the same name already exists");
  }

  if (parentClassId) {
    await assertNoClassCycle(null, parentClassId);
  }

  return await warehouseLocationClassRepository.createWarehouseLocationClass({
    ...classData,
    name: className,
    parentClassId,
  });
};

const getAllWarehouseLocationClasses = async () => {
  return await warehouseLocationClassRepository.getAllWarehouseLocationClasses();
};

const getWarehouseLocationClassByField = async (field, value) => {
  return await warehouseLocationClassRepository.getWarehouseLocationClassByField(
    field,
    value,
  );
};

const updateWarehouseLocationClass = async (id, updateData) => {
  const currentClass =
    await warehouseLocationClassRepository.getWarehouseLocationClassFirstByField(
      "id",
      id,
    );

  if (!currentClass) {
    throw new Error("Location class not found");
  }

  const nextName = updateData.name
    ? normalizeText(updateData.name)
    : currentClass.name;

  if (!nextName) {
    throw new Error("Location class name is required");
  }

  if (nextName !== currentClass.name) {
    const existingClass =
      await warehouseLocationClassRepository.getWarehouseLocationClassFirstByField(
        "name",
        nextName,
      );

    if (existingClass && existingClass.id !== id) {
      throw new Error("A location class with the same name already exists");
    }
  }

  const hasParentClassId = Object.prototype.hasOwnProperty.call(
    updateData,
    "parentClassId",
  );
  const nextParentClassId = hasParentClassId
    ? updateData.parentClassId
    : currentClass.parentClassId;

  if (nextParentClassId === id) {
    throw new Error("A location class cannot be its own parent");
  }

  if (nextParentClassId) {
    await assertNoClassCycle(id, nextParentClassId);
  }

  return await warehouseLocationClassRepository.updateWarehouseLocationClass(
    id,
    {
      ...updateData,
      name: nextName,
      parentClassId: nextParentClassId ?? null,
    },
  );
};

/** Child classes and the locations of this kind, for the warning before a delete. */
const getWarehouseLocationClassDependents = async (id) => {
  const locationClass = await prisma.warehouseLocationClass.findUnique({ where: { id } });
  if (!locationClass) {
    throw notFound("Location class");
  }

  const [childClasses, locations] = await Promise.all([
    prisma.warehouseLocationClass.count({ where: { parentClassId: id } }),
    prisma.warehouseLocation.count({ where: { locationClassId: id } }),
  ]);

  return {
    locationClass,
    report: buildReport({
      blocking: [
        {
          key: "childClasses",
          label: "Classes that sit inside it",
          count: childClasses,
          where: "/warehouse-locations",
          note: "Delete them, or give them a different parent class.",
        },
        {
          key: "locations",
          label: "Locations of this class",
          count: locations,
          where: "/warehouse-locations",
          note: "Delete them, or change their class.",
        },
      ],
    }),
  };
};

/**
 * @throws {HasDependentsError} (409) while classes or locations still use it
 */
const deleteWarehouseLocationClass = async (id, actorUserId) => {
  const { locationClass, report } = await getWarehouseLocationClassDependents(id);
  assertDeletable(locationClass.name, report);

  await warehouseLocationClassRepository.deleteWarehouseLocationClass(id);

  if (actorUserId) {
    await auditLogLogic
      .createAuditLog(actorUserId, "DELETE_LOCATION_CLASS", {
        locationClassId: id,
        name: locationClass.name,
      })
      .catch((err) => console.error("Audit log error:", err.message));
  }

  return locationClass;
};

const resolveLocationName = (payload = {}, fallbackValue) => {
  const locationName = normalizeText(payload.locationName ?? payload.name ?? fallbackValue);
  return typeof locationName === "string" && locationName.length > 0
    ? locationName
    : "";
};

const resolveLocationClass = async (payload = {}, fallbackClassId) => {
  const explicitClassId = payload.locationClassId ?? payload.classId ?? null;
  if (explicitClassId) {
    const locationClass = await resolveLocationClassById(explicitClassId);
    if (!locationClass) {
      throw new Error("Invalid location class");
    }
    return locationClass;
  }

  if (payload.class) {
    const locationClass =
      await warehouseLocationClassRepository.getWarehouseLocationClassFirstByField(
        "name",
        payload.class,
      );

    if (!locationClass) {
      throw new Error("Invalid location class");
    }

    return locationClass;
  }

  if (fallbackClassId) {
    const locationClass = await resolveLocationClassById(fallbackClassId);
    if (!locationClass) {
      throw new Error("Invalid location class");
    }
    return locationClass;
  }

  throw new Error("Location class is required");
};

const resolveLocationClassById = async (classId) => {
  return await warehouseLocationClassRepository.getWarehouseLocationClassFirstByField(
    "id",
    classId,
  );
};

const resolveParentLocation = async (parentLocationId) => {
  if (!parentLocationId) {
    return null;
  }

  const parentLocation =
    await warehouseLocationRepository.getWarehouseLocationFirstByField(
      "id",
      parentLocationId,
    );

  if (!parentLocation) {
    throw new Error("Parent location does not exist");
  }

  return parentLocation;
};

const validateParentClass = (locationClass, parentLocation) => {
  if (!locationClass.parentClassId) {
    if (parentLocation) {
      throw new Error("A root location class cannot have a parent location");
    }
    return;
  }

  if (!parentLocation) {
    throw new Error("A parent location is required for this location class");
  }

  if (parentLocation.locationClassId !== locationClass.parentClassId) {
    throw new Error("Invalid parent location class");
  }
};

const createMaterializedPath = (locationName, parentLocationPath) => {
  const nameSlug = normalizeText(locationName).toLowerCase().replace(/\s+/g, "-");

  if (parentLocationPath) {
    return `${parentLocationPath}/${nameSlug}`;
  }

  return nameSlug;
};

const buildWarehouseLocationPayload = (sourceData, normalizedFields) => {
  const payload = {
    ...sourceData,
    ...normalizedFields,
  };

  delete payload.class;
  delete payload.classId;
  delete payload.name;

  return payload;
};

const normalizeText = (value) => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : "";
};

const assertNoClassCycle = async (currentClassId, nextParentClassId) => {
  let cursor = nextParentClassId;

  while (cursor) {
    if (cursor === currentClassId) {
      throw new Error("Location class hierarchy cannot contain a cycle");
    }

    const parentClass =
      await warehouseLocationClassRepository.getWarehouseLocationClassFirstByField(
        "id",
        cursor,
      );

    cursor = parentClass?.parentClassId ?? null;
  }
};

// US-029: Build a nested tree from the flat list of all warehouse locations
const getWarehouseLocationTree = async () => {
  const allLocations = await warehouseLocationRepository.getAllWarehouseLocations();

  // Index by id for O(1) parent lookup
  const locationMap = new Map();
  for (const loc of allLocations) {
    locationMap.set(loc.id, { ...loc, children: [] });
  }

  const roots = [];
  for (const loc of locationMap.values()) {
    if (!loc.parentLocationId) {
      roots.push(loc);
    } else {
      const parent = locationMap.get(loc.parentLocationId);
      if (parent) {
        parent.children.push(loc);
      } else {
        // Orphaned node (parent deleted) — promote to root
        roots.push(loc);
      }
    }
  }

  return roots;
};

module.exports = {
  WAREHOUSE_LOCATION_LIST_SPEC,
  summariseWarehouseLocations,
  createWarehouseLocation,
  getAllWarehouseLocations,
  getWarehouseLocationByField,
  getWarehouseLocationTree,
  updateWarehouseLocation,
  getWarehouseLocationDependents,
  deleteWarehouseLocation,
  createWarehouseLocationClass,
  getAllWarehouseLocationClasses,
  getWarehouseLocationClassByField,
  updateWarehouseLocationClass,
  getWarehouseLocationClassDependents,
  deleteWarehouseLocationClass,
};
