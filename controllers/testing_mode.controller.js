// TESTING-ONLY (whole file) — delete it with the rest; see TESTING_RELAXATIONS.md.

const testingModeLogic = require("../logic/testing_mode.logic");

const fail = (res, err) => res.status(err.status || 500).json({ error: err.message });

/** Whether testing deletes are on, for the admin banner and the delete buttons. */
const getTestingMode = async (req, res) => {
  try {
    res.status(200).json(await testingModeLogic.testingDeletesStatus());
  } catch (err) {
    fail(res, err);
  }
};

/** Turns them on for a week. */
const turnOnTestingMode = async (req, res) => {
  try {
    res.status(200).json(await testingModeLogic.turnOnTestingDeletes(req.user?.id));
  } catch (err) {
    fail(res, err);
  }
};

/** Turns them off, or dismisses a week that has ended. */
const turnOffTestingMode = async (req, res) => {
  try {
    res.status(200).json(await testingModeLogic.turnOffTestingDeletes(req.user?.id));
  } catch (err) {
    fail(res, err);
  }
};

module.exports = { getTestingMode, turnOnTestingMode, turnOffTestingMode };
