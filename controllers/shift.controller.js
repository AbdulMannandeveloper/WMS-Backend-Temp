const shiftLogic = require('../logic/shift.logic');
const { dependentsBody } = require('../utils/dependents');

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
    const shift = await shiftLogic.getShiftById(req.params.id);
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
    const shift = await shiftLogic.updateShift(req.params.id, req.body, req.user.id);
    res.status(200).json(shift);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
};

// What a delete would refuse on, asked before pressing it.
const getShiftDependents = async (req, res) => {
  try {
    const { report } = await shiftLogic.getShiftDependents(req.params.id);
    res.status(200).json(report);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
};

const deleteShift = async (req, res) => {
  try {
    const shift = await shiftLogic.deleteShift(req.params.id, req.user.id);
    res.status(200).json(shift);
  } catch (error) {
    if (error.code === "HAS_DEPENDENTS") return res.status(409).json(dependentsBody(error));
    res.status(error.status || 400).json({ error: error.message });
  }
};

module.exports = {
  createShift,
  getAllShifts,
  getShiftByField,
  getShiftById,
  updateShift,
  getShiftDependents,
  deleteShift
};