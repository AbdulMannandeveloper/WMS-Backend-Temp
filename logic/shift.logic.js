const shiftRepository = require("../repositories/shift.repository");
const auditLogLogic = require("./audit_log.logic");
const { prisma } = require("../lib/prisma");
const { buildReport, assertDeletable, lockForDelete } = require("../utils/dependents");

/**
 * Check-in times every arrival against the shift called "default", found by
 * that name (attendance_log.logic). Without it, attendance quietly stops being
 * recorded — login swallows the error — so it is neither deleted nor renamed.
 */
const DEFAULT_SHIFT_NAME = "default";

/** Shift names ignore case and surrounding spaces, as check-in's lookup does. */
const sameName = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.trim().toLowerCase() === b.trim().toLowerCase();

const isDefaultShift = (name) => sameName(name, DEFAULT_SHIFT_NAME);

/** What a shift edit may change. Anything else in the body is ignored. */
const SHIFT_UPDATE_FIELDS = ["name", "startTime", "endTime", "gracePeriodMins"];

const notFound = (what) => {
  const error = new Error(`${what} not found.`);
  error.status = 404;
  return error;
};

const createShift = async (shiftData) => {
  if (typeof shiftData.name === "string") shiftData.name = shiftData.name.trim();
  if (!shiftData.name || !shiftData.startTime || !shiftData.endTime) {
    throw new Error("Missing required fields: ShiftName, startTime, endTime");
  }

  if (new Date(shiftData.startTime) >= new Date(shiftData.endTime)) {
    throw new Error("startTime must be before endTime");
  }

  // Check for shift with the same name
  const existingShifts = await shiftRepository.getAllShifts();
  if (existingShifts.some((shift) => sameName(shift.name, shiftData.name))) {
    throw new Error("Shift with the same name already exists");
  }

  return await shiftRepository.createShift(shiftData);
};

const getAllShifts = async () => {
  return await shiftRepository.getAllShifts();
};

const getShiftById = async (id) => {
  return await shiftRepository.getShiftById(id);
};

const getShiftByField = async (field, value) => {
  return await shiftRepository.getShiftByField(field, value);
};

const updateShift = async (id, rawData, actorUserId) => {
  const shift = await shiftRepository.getShiftById(id);
  if (!shift) throw notFound("Shift");

  const updateData = {};
  for (const field of SHIFT_UPDATE_FIELDS) {
    if (rawData && field in rawData) updateData[field] = rawData[field];
  }

  if ("name" in updateData) {
    updateData.name = typeof updateData.name === "string" ? updateData.name.trim() : updateData.name;
    if (!updateData.name) throw new Error("Shift name is required.");
  }

  // Recasing it ("Default") is still the default shift, so that is allowed.
  if ("name" in updateData && isDefaultShift(shift.name) && !isDefaultShift(updateData.name)) {
    throw new Error(
      'The "default" shift is the one check-in times against, so it cannot be renamed.',
    );
  }
  if ("gracePeriodMins" in updateData) {
    const grace = Number(updateData.gracePeriodMins);
    if (!Number.isInteger(grace) || grace < 0) {
      throw new Error("gracePeriodMins must be a whole number of minutes, zero or more");
    }
    updateData.gracePeriodMins = grace;
  }

  // Checked against what is stored when only one end changes, so a shift
  // cannot be edited into ending before it starts.
  const start = new Date(updateData.startTime ?? shift.startTime);
  const end = new Date(updateData.endTime ?? shift.endTime);
  if (start >= end) {
    throw new Error("startTime must be before endTime");
  }

  // Check for shift with the same name (excluding the current shift)
  if (updateData.name) {
    const existingShifts = await shiftRepository.getAllShifts();
    if (
      existingShifts.some(
        (shift) => sameName(shift.name, updateData.name) && shift.id !== id,
      )
    ) {
      throw new Error("Shift with the same name already exists");
    }
  }

  const updated = await shiftRepository.updateShift(id, updateData);
  await auditLogLogic.auditChange(
    actorUserId,
    "UPDATE_SHIFT",
    { shiftId: id, name: updated.name },
    shift,
    updated,
    Object.keys(updateData),
  );
  return updated;
};

/**
 * What deleting a shift would refuse on. Nothing refers to a shift by id; the
 * one thing that depends on one is check-in, on the "default" shift by name.
 */
const getShiftDependents = async (id, tx) => {
  const shift = await shiftRepository.getShiftById(id, tx);
  if (!shift) throw notFound("Shift");
  return {
    shift,
    report: buildReport({
      blocking: [
        {
          key: "checkIn",
          label: "Check-in uses it",
          count: isDefaultShift(shift.name) ? 1 : 0,
          note: "Every clock-in is timed against the default shift. Change its hours instead.",
        },
      ],
    }),
  };
};

const deleteShift = async (id, actorUserId) => {
  // Locked, so a rename to or from "default" cannot slip in between.
  const { shift, deleted } = await prisma.$transaction(async (tx) => {
    await lockForDelete(tx, "shifts", id);
    const { shift, report } = await getShiftDependents(id, tx);
    assertDeletable(`Shift "${shift.name}"`, report);
    return { shift, deleted: await shiftRepository.deleteShift(id, tx) };
  });
  await auditLogLogic.auditQuietly(actorUserId, "DELETE_SHIFT", {
    shiftId: id,
    name: shift.name,
    startTime: shift.startTime,
    endTime: shift.endTime,
    gracePeriodMins: shift.gracePeriodMins,
  });
  return deleted;
};

module.exports = {
  createShift,
  getAllShifts,
  getShiftById,
  getShiftByField,
  updateShift,
  getShiftDependents,
  deleteShift,
};
