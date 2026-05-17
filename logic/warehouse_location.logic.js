const warehhouseLocationRepository = require("../repositories/warehouse_location.repository");

const LocationClass = {
  WAREHOUSE,
  ZONE,
  AISLE,
  SHELF,
};

// const validParentClasses = {
//   AISLE: ["ZONE"],
//   BAY: ["AISLE"],
//   SHELF: ["BAY"],
//   BIN: ["SHELF"],
//   STAGING: ["ZONE", "AISLE", "BAY", "SHELF", "BIN"],
//   RECEIVING: ["ZONE", "AISLE", "BAY", "SHELF", "BIN"],
//   SHIPPING: ["ZONE", "AISLE", "BAY", "SHELF", "BIN"],
// };

const createWarehouseLocation = async (locationData) => {
  // Location class validation
  if (!locationData.class) {
    throw new Error("Location class is required");
  }
  if (!LocationClass[locationData.class]) {
    throw new Error("Invalid location class");
  }

  // Parent location validation
  if (!locationData.parentLocationId) {
    if (locationData.class !== "ZONE") {
      throw new Error("A parent location is required for non-ZONE classes");
    }
  }
  const parentLocation =
    await warehhouseLocationRepository.getWarehouseLocationByField(
      "id",
      locationData.parentLocationId,
    );
  if (!parentLocation) {
    throw new Error("Parent location does not exist");
  }
  // else {
  //   if (
  //     !validParentClasses[locationData.class]?.includes(parentLocation.class)
  //   ) {
  //     throw new Error("Invalid parent location class");
  //   }
  // }

  // Unique name validation within the same parent location
  const existingLocation =
    await warehhouseLocationRepository.getWarehouseLocationByField(
      "name",
      locationData.name,
    );
  if (
    existingLocation &&
    existingLocation.parentLocationId === locationData.parentLocationId
  ) {
    throw new Error(
      "A location with the same name already exists under the same parent location",
    );
  }

  // Create materialized path
  if (LocationClass != "ZONE") {
    locationData.materializedPath = await createMaterializedPath(
      locationData.name,
      parentLocation.materializedPath,
    );
  } else {
    locationData.materializedPath = await createMaterializedPath(
      locationData.name,
      null,
    );
  }

  return await warehhouseLocationRepository.createWarehouseLocation(
    locationData,
  );
};

const getAllWarehouseLocations = async () => {
  return await warehhouseLocationRepository.getAllWarehouseLocations();
};

const getWarehouseLocationByField = async (field, value) => {
  return await warehhouseLocationRepository.getWarehouseLocationByField(
    field,
    value,
  );
};

const updateWarehouseLocation = async (id, updateData) => {
  // Location class validation
  if (updateData.class && !LocationClass[updateData.class]) {
    throw new Error("Invalid location class");
  }

  // Parent location validation
  if (updateData.parentLocationId) {
    const parentLocation =
      await warehhouseLocationRepository.getWarehouseLocationByField(
        "id",
        updateData.parentLocationId,
      );
    if (!parentLocation) {
      throw new Error("Parent location does not exist");
    }

    // Create materialized path if parent location is changed if name is not being updated
    if (!updateData.name) {
      const currentLocation =
        await warehhouseLocationRepository.getWarehouseLocationByField(
          "id",
          id,
        );
      updateData.materializedPath = await createMaterializedPath(
        currentLocation.name,
        parentLocation.materializedPath,
      );
    }
  }

  // Unique name validation within the same parent location
  if (updateData.name) {
    const existingLocation =
      await warehhouseLocationRepository.getWarehouseLocationByField(
        "name",
        updateData.name,
      );
    if (
      existingLocation &&
      existingLocation.parentLocationId === updateData.parentLocationId
    ) {
      throw new Error(
        "A location with the same name already exists under the same parent location",
      );
    }
    // Update materialized path if name is changed
    if (updateData.parentLocationId) {
      const parentLocation =
        await warehhouseLocationRepository.getWarehouseLocationByField(
          "id",
          updateData.parentLocationId,
        );
      updateData.materializedPath = await createMaterializedPath(
        updateData.name,
        parentLocation.materializedPath,
      );
    } else {
      const currentLocation =
        await warehhouseLocationRepository.getWarehouseLocationByField(
          "id",
          id,
        );
      updateData.materializedPath = await createMaterializedPath(
        updateData.name,
        currentLocation.materializedPath.split("/").slice(0, -1).join("/"),
      );
    }
  }

  return await warehhouseLocationRepository.updateWarehouseLocation(
    id,
    updateData,
  );
};

const deleteWarehouseLocation = async (id) => {

  const locationToDelete =
    await warehhouseLocationRepository.getWarehouseLocationByField("id", id);
  
    // Prevent deletion if location has child locations
    const childLocations =
    await warehhouseLocationRepository.getWarehouseLocationByField(
      "parentLocationId",
      id,
    );
  if (childLocations && childLocations.length > 0) {
    throw new Error("Cannot delete location with child locations");
  }

  // Prevent deletion if location is referenced in inventory or other tables
  // TODO: Implement reference checking logic
  return await warehhouseLocationRepository.deleteWarehouseLocation(id);
};

// ------------------------------- Supporting local functions -------------------------------
// Local function to create materializedPath for a location from name and parent location
const createMaterializedPath = async (locationName, parentLocationPath) => {
  let name_slug = locationName.toLowerCase().replace(/\s+/g, "-");
  if (parentLocationPath) {
    return `${parentLocationPath}/${name_slug}`;
  } else {
    return name_slug;
  }
};

module.exports = {
  createWarehouseLocation,
  getAllWarehouseLocations,
  getWarehouseLocationByField,
  updateWarehouseLocation,
  deleteWarehouseLocation,
};
