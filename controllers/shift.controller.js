const shiftLogic = require('../logic/shift.logic');

const createShift = async (req, res) => {
  try {
    const shift = await shiftLogic.createShift(req.body);
    res.status(201).json(shift);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getAllShifts = async (req, res) => {
  try {
    const shifts = await shiftLogic.getAllShifts();
    res.status(200).json(shifts);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getShiftByField = async (req, res) => {
  try {
    const shift = await shiftLogic.getShiftByField(req.params.field, req.params.value);
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    res.status(200).json(shift);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getShiftById = async (req, res) => {
  try {
    const shift = await shiftLogic.getShiftById(parseInt(req.params.id));
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    res.status(200).json(shift);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const updateShift = async (req, res) => {
  try {
    const shift = await shiftLogic.updateShift(parseInt(req.params.id), req.body);
    res.status(200).json(shift);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const deleteShift = async (req, res) => {
  try {
    const shift = await shiftLogic.deleteShift(parseInt(req.params.id));
    res.status(200).json(shift);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  createShift,
  getAllShifts,
  getShiftByField,
  getShiftById,
  updateShift,
  deleteShift
};