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
const { buildReport, assertDeletable, lockForDelete } = require("../utils/dependents");

const createWarehouseLocation = async (locationData) => {
  const locationName = resolveLocationName(locationData);
  if (!locationName) {
    throw new Error("Location name is required");
  }

  const locationClass = await resolveLocationClass(locationData);
  const parentLocationId = locationData.parentLocationId ?? null;
  const parentLocation = await resolveParentLocation(parentLocationId);

  assertClassOpen(locationClass);
  assertParentOpen(parentLocation);
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
      // Paths are lowercase slugs (createMaterializedPath), so the prefix is too.
      const prefix = parseString(q.pathPrefix, { label: "pathPrefix" });
      return prefix ? { materializedPath: { startsWith: prefix.toLowerCase() } } : undefined;
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

  // Only a change is checked: renaming a location of a deactivated class, or
  // inside a deactivated parent, is still fine.
  if (locationClass.id !== currentLocation.locationClassId) assertClassOpen(locationClass);
  if (nextParentLocationId !== currentLocation.parentLocationId) assertParentOpen(parentLocation);
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

const refuse = (message) => {
  const err = new Error(message);
  err.status = 409;
  return err;
};

/** Nothing new takes a deactivated class. */
const assertClassOpen = (locationClass) => {
  if (locationClass && locationClass.isActive === false) {
    throw refuse(`The class ${locationClass.name} is deactivated, so no new location can take it.`);
  }
};

/** Nothing new goes inside a deactivated location. */
const assertParentOpen = (parentLocation) => {
  if (parentLocation && parentLocation.isActive === false) {
    throw refuse(`${parentLocation.locationName} is deactivated, so nothing new can go inside it.`);
  }
};

const parseActive = (value) => {
  if (typeof value !== "boolean") {
    throw new Error("isActive must be true or false.");
  }
  return value;
};

/**
 * Switches a location off or back on. Off, it keeps its stock history but no
 * stock can be put into it and nothing new can go inside it — the way out
 * for one that has held stock and so can never be deleted.
 *
 * Only an empty location with no active locations inside it can be switched
 * off: stock on a shelf nobody can choose is stock nobody finds. Switching
 * back on needs its parent and its class on, or it would be an open shelf in
 * a closed aisle.
 */
const setWarehouseLocationActive = async (id, rawIsActive, actorUserId) => {
  const isActive = parseActive(rawIsActive);
  const location = await prisma.warehouseLocation.findUnique({
    where: { id },
    include: { parentLocation: true, locationClass: true },
  });
  if (!location) throw notFound("Location");
  if (location.isActive === isActive) return location;

  if (isActive) {
    if (location.parentLocation && !location.parentLocation.isActive) {
      throw refuse(
        `${location.parentLocation.locationName}, which it sits in, is deactivated. Reactivate that first.`,
      );
    }
    if (!location.locationClass.isActive) {
      throw refuse(`Its class, ${location.locationClass.name}, is deactivated. Reactivate that first.`);
    }
  } else {
    const [stocked, activeChildren] = await Promise.all([
      prisma.stockLevel.count({
        where: {
          locationId: id,
          OR: [{ currentQuantity: { gt: 0 } }, { reservedQuantity: { gt: 0 } }],
        },
      }),
      prisma.warehouseLocation.count({ where: { parentLocationId: id, isActive: true } }),
    ]);
    if (stocked > 0) {
      throw refuse(
        `${location.locationName} still holds stock for ${stocked} product(s). Move it somewhere else first.`,
      );
    }
    if (activeChildren > 0) {
      throw refuse(
        `${location.locationName} has ${activeChildren} active location(s) inside it. Deactivate those first.`,
      );
    }
  }

  const updated = await prisma.warehouseLocation.update({ where: { id }, data: { isActive } });
  await auditLogLogic.auditQuietly(actorUserId, isActive ? "REACTIVATE_LOCATION" : "DEACTIVATE_LOCATION", {
    locationId: id,
    locationName: location.locationName,
    path: location.materializedPath,
  });
  return updated;
};

/**
 * Switches a location class off or back on. Off, existing locations keep it
 * but no new one can take it. Off needs no active location of this class and
 * no active class inside it; on needs its parent class on.
 */
const setWarehouseLocationClassActive = async (id, rawIsActive, actorUserId) => {
  const isActive = parseActive(rawIsActive);
  const locationClass = await prisma.warehouseLocationClass.findUnique({
    where: { id },
    include: { parentClass: true },
  });
  if (!locationClass) throw notFound("Location class");
  if (locationClass.isActive === isActive) return locationClass;

  if (isActive) {
    if (locationClass.parentClass && !locationClass.parentClass.isActive) {
      throw refuse(`Its parent class, ${locationClass.parentClass.name}, is deactivated. Reactivate that first.`);
    }
  } else {
    const [activeLocations, activeChildClasses] = await Promise.all([
      prisma.warehouseLocation.count({ where: { locationClassId: id, isActive: true } }),
      prisma.warehouseLocationClass.count({ where: { parentClassId: id, isActive: true } }),
    ]);
    if (activeLocations > 0) {
      throw refuse(
        `${activeLocations} active location(s) are of the class ${locationClass.name}. Deactivate them or change their class first.`,
      );
    }
    if (activeChildClasses > 0) {
      throw refuse(
        `${activeChildClasses} active class(es) sit inside ${locationClass.name}. Deactivate them first.`,
      );
    }
  }

  const updated = await prisma.warehouseLocationClass.update({ where: { id }, data: { isActive } });
  await auditLogLogic.auditQuietly(
    actorUserId,
    isActive ? "REACTIVATE_LOCATION_CLASS" : "DEACTIVATE_LOCATION_CLASS",
    { locationClassId: id, name: locationClass.name },
  );
  return updated;
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
const getWarehouseLocationDependents = async (id, tx) => {
  const db = tx ?? prisma;
  const location = await db.warehouseLocation.findUnique({ where: { id } });
  if (!location) {
    throw notFound("Location");
  }

  const occupied = {
    locationId: id,
    OR: [{ currentQuantity: { gt: 0 } }, { reservedQuantity: { gt: 0 } }],
  };
  const [children, stocked, emptySlots, shipmentLines, fbaLines, returns, movements] =
    await Promise.all([
      db.warehouseLocation.count({ where: { parentLocationId: id } }),
      db.stockLevel.count({ where: occupied }),
      db.stockLevel.count({ where: { locationId: id, NOT: occupied } }),
      db.shipmentItem.count({ where: { sourceLocationId: id } }),
      db.fbaShipmentItem.count({ where: { sourceLocationId: id } }),
      db.productReturn.count({ where: { restockLocationId: id } }),
      db.inventoryLedger.count({
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
          note: "Stock history is permanent. Deactivate this location instead of deleting it.",
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
  // Locked first: a check-in or move writes its ledger line, which names this
  // location, before it touches stock — so it waits here and cannot fill a row
  // that is about to be deleted as empty.
  const location = await prisma.$transaction(async (tx) => {
    await lockForDelete(tx, "warehouse_locations", id);
    const { location, report } = await getWarehouseLocationDependents(id, tx);
    assertDeletable(location.locationName, report, { deactivatable: true });

    // StockLevel.location is Restrict, so the empty rows have to go first.
    // Only empty ones, whatever the check said: a full row stops the delete.
    await tx.stockLevel.deleteMany({
      where: { locationId: id, currentQuantity: 0, reservedQuantity: 0 },
    });
    await tx.warehouseLocation.delete({ where: { id } });
    return location;
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
  if (parentClass && parentClass.isActive === false) {
    throw refuse(`${parentClass.name} is deactivated, so no new class can sit inside it.`);
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
    name: className,
    description: classData.description,
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
  if (nextParentClassId && nextParentClassId !== currentClass.parentClassId) {
    const nextParent = await resolveLocationClassById(nextParentClassId);
    if (nextParent && nextParent.isActive === false) {
      throw refuse(`${nextParent.name} is deactivated, so no class can be moved inside it.`);
    }
  }

  // Only the fields a class has: the body used to be spread in whole, which
  // would have let an edit switch isActive past its admin-only route.
  return await warehouseLocationClassRepository.updateWarehouseLocationClass(
    id,
    {
      ...("description" in updateData ? { description: updateData.description } : {}),
      name: nextName,
      parentClassId: nextParentClassId ?? null,
    },
  );
};

/** Child classes and the locations of this kind, for the warning before a delete. */
const getWarehouseLocationClassDependents = async (id, tx) => {
  const db = tx ?? prisma;
  const locationClass = await db.warehouseLocationClass.findUnique({ where: { id } });
  if (!locationClass) {
    throw notFound("Location class");
  }

  const [childClasses, locations] = await Promise.all([
    db.warehouseLocationClass.count({ where: { parentClassId: id } }),
    db.warehouseLocation.count({ where: { locationClassId: id } }),
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
  const locationClass = await prisma.$transaction(async (tx) => {
    await lockForDelete(tx, "warehouse_location_classes", id);
    const { locationClass, report } = await getWarehouseLocationClassDependents(id, tx);
    assertDeletable(locationClass.name, report, { deactivatable: true });
    await warehouseLocationClassRepository.deleteWarehouseLocationClass(id, tx);
    return locationClass;
  });

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

// Only the fields a location has. The request body used to be spread in whole,
// which would have let an edit switch isActive past its admin-only route.
const buildWarehouseLocationPayload = (_sourceData, normalizedFields) => ({
  ...normalizedFields,
});

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
  setWarehouseLocationActive,
  createWarehouseLocationClass,
  getAllWarehouseLocationClasses,
  getWarehouseLocationClassByField,
  updateWarehouseLocationClass,
  getWarehouseLocationClassDependents,
  deleteWarehouseLocationClass,
  setWarehouseLocationClassActive,
};
