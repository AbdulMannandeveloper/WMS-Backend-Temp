const holidayRepository = require("../repositories/holiday.repository");

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

const updateHoliday = async (id, updateData) => {
  if (updateData.startDate) {
    if (updateData.endDate) {
      if (new Date(updateData.startDate) > new Date(updateData.endDate)) {
        throw new Error("startDate must be before endDate");
      }
    } else {
      updateData.endDate = updateData.startDate;
    }
  }
  return await holidayRepository.updateHoliday(id, updateData);
};

const deleteHoliday = async (id) => {
  return await holidayRepository.deleteHoliday(id);
};

module.exports = {
  createHoliday,
  getAllHolidays,
  getHolidayById,
  updateHoliday,
  deleteHoliday,
};
