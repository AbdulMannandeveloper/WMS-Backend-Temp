const shiftRepository = require("../repositories/shift.repository");

const createShift = async (shiftData) => {
  if (!shiftData.name || !shiftData.startTime || !shiftData.endTime) {
    throw new Error("Missing required fields: ShiftName, startTime, endTime");
  }

  if (new Date(shiftData.startTime) >= new Date(shiftData.endTime)) {
    throw new Error("startTime must be before endTime");
  }

  // Check for shift with the same name
  const existingShifts = await shiftRepository.getAllShifts();
  if (existingShifts.some((shift) => shift.name === shiftData.name)) {
    throw new Error("Shift with the same name already exists");
  }

  return await shiftRepository.createShift(shiftData);
};

const getAllShifts = async () => {
  return await shiftRepository.getAllShifts();
};

const getShiftByField = async (field, value) => {
  return await shiftRepository.getShiftByField(field, value);
};

const updateShift = async (id, updateData) => {
  if (updateData.startTime && updateData.endTime) {
    if (new Date(updateData.startTime) >= new Date(updateData.endTime)) {
      throw new Error("startTime must be before endTime");
    }
  }

  // Check for shift with the same name (excluding the current shift)
  if (updateData.name) {
    const existingShifts = await shiftRepository.getAllShifts();
    if (
      existingShifts.some(
        (shift) => shift.name === updateData.name && shift.id !== id,
      )
    ) {
      throw new Error("Shift with the same name already exists");
    }
  }

  return await shiftRepository.updateShift(id, updateData);
};

const deleteShift = async (id) => {
  return await shiftRepository.deleteShift(id);
};

module.exports = {
  createShift,
  getAllShifts,
  getShiftByField,
  updateShift,
  deleteShift,
};
