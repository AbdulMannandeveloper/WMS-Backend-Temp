const warehouseLocationRepository = require("../repositories/warehouse_location.repository");
const warehouseLocationClassRepository = require("../repositories/warehouse_location_class.repository");

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

const getAllWarehouseLocations = async () => {
  return await warehouseLocationRepository.getAllWarehouseLocations();
};

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

const deleteWarehouseLocation = async (id) => {
  const childLocations =
    await warehouseLocationRepository.getWarehouseLocationByField(
      "parentLocationId",
      id,
    );

  if (childLocations && childLocations.length > 0) {
    throw new Error("Cannot delete location with child locations");
  }

  return await warehouseLocationRepository.deleteWarehouseLocation(id);
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

const deleteWarehouseLocationClass = async (id) => {
  const childClasses =
    await warehouseLocationClassRepository.getWarehouseLocationClassByField(
      "parentClassId",
      id,
    );
  const locations = await warehouseLocationRepository.getWarehouseLocationByField(
    "locationClassId",
    id,
  );

  if (childClasses && childClasses.length > 0) {
    throw new Error("Cannot delete a location class that has child classes");
  }

  if (locations && locations.length > 0) {
    throw new Error("Cannot delete a location class that is assigned to locations");
  }

  return await warehouseLocationClassRepository.deleteWarehouseLocationClass(id);
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
  createWarehouseLocation,
  getAllWarehouseLocations,
  getWarehouseLocationByField,
  getWarehouseLocationTree,
  updateWarehouseLocation,
  deleteWarehouseLocation,
  createWarehouseLocationClass,
  getAllWarehouseLocationClasses,
  getWarehouseLocationClassByField,
  updateWarehouseLocationClass,
  deleteWarehouseLocationClass,
};
