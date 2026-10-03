const holidayRepository = require("../repositories/holiday.repository");
const auditLogLogic = require("./audit_log.logic");

const createHoliday = async (holidayData) => {
  if (!holidayData.name || !holidayData.startDate) {
    throw new Error("Missing required fields: name, startDate");
  }

  if (holidayData.endDate) {
    if (new Date(holidayData.startDate) > new Date(holidayData.endDate)) {
      throw new Error("startDate must be before endDate");
    }
  } else {
    holidayData.endDate = holidayData.startDate;
  }
  return await holidayRepository.createHoliday(holidayData);
};

const getAllHolidays = async () => {
  return await holidayRepository.getAllHolidays();
};

const getHolidayById = async (id) => {
  return await holidayRepository.getHolidayById(id);
};

/** What a holiday edit may change. Anything else in the body is ignored. */
const HOLIDAY_UPDATE_FIELDS = ["name", "startDate", "endDate"];

const notFound = () => {
  const error = new Error("Holiday not found.");
  error.status = 404;
  return error;
};

const updateHoliday = async (id, rawData, actorUserId) => {
  const holiday = await holidayRepository.getHolidayById(id);
  if (!holiday) throw notFound();

  const updateData = {};
  for (const field of HOLIDAY_UPDATE_FIELDS) {
    if (rawData && field in rawData) updateData[field] = rawData[field];
  }
  if ("name" in updateData) {
    updateData.name = String(updateData.name ?? "").trim();
    if (!updateData.name) throw new Error("A holiday needs a name.");
  }
  // An empty end date means a one-day holiday.
  if ("endDate" in updateData && !updateData.endDate) {
    updateData.endDate = updateData.startDate ?? holiday.startDate;
  }

  // Checked against what is stored, so changing one end alone neither slips
  // past the check nor collapses a multi-day holiday to its first day.
  const start = new Date(updateData.startDate ?? holiday.startDate);
  const end = new Date(updateData.endDate ?? holiday.endDate ?? start);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Holiday dates must be valid dates");
  }
  if (start > end) {
    throw new Error("startDate must be before endDate");
  }

  const updated = await holidayRepository.updateHoliday(id, updateData);
  await auditLogLogic.auditChange(
    actorUserId,
    "UPDATE_HOLIDAY",
    { holidayId: id, name: updated.name },
    holiday,
    updated,
    Object.keys(updateData),
  );
  return updated;
};

const deleteHoliday = async (id, actorUserId) => {
  const holiday = await holidayRepository.getHolidayById(id);
  if (!holiday) throw notFound();
  const deleted = await holidayRepository.deleteHoliday(id);
  await auditLogLogic.auditQuietly(actorUserId, "DELETE_HOLIDAY", {
    holidayId: id,
    name: holiday.name,
    startDate: holiday.startDate,
    endDate: holiday.endDate,
  });
  return deleted;
};

module.exports = {
  createHoliday,
  getAllHolidays,
  getHolidayById,
  updateHoliday,
  deleteHoliday,
};
