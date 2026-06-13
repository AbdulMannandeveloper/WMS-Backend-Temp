const holidayLogic = require("../logic/holiday.logic");

const createHoliday = async (req, res) => {
  try {
    const holiday = await holidayLogic.createHoliday(req.body);
    res.status(201).json(holiday);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getAllHolidays = async (req, res) => {
  try {
    const holidays = await holidayLogic.getAllHolidays();
    res.status(200).json(holidays);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getHolidayById = async (req, res) => {
  try {
    const holiday = await holidayLogic.getHolidayById(req.params.id);
    if (!holiday) {
      return res.status(404).json({ error: "Holiday not found" });
    }
    res.status(200).json(holiday);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const updateHoliday = async (req, res) => {
  try {
    const holiday = await holidayLogic.updateHoliday(
      req.params.id,
      req.body,
    );
    res.status(200).json(holiday);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const deleteHoliday = async (req, res) => {
  try {
    const holiday = await holidayLogic.deleteHoliday(req.params.id);
    res.status(200).json(holiday);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  createHoliday,
  getAllHolidays,
  getHolidayById,
  updateHoliday,
  deleteHoliday,
};
