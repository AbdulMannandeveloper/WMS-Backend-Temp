// TESTING-ONLY (whole file) — delete it with the rest; see TESTING_RELAXATIONS.md.

import testingModeLogic from '../../logic/testing_mode.logic.js';

/**
 * Turns testing deletes on, as an admin pressing the switch would. Off again
 * for the next test: the database is truncated before each one.
 */
export const enableTestingDeletes = () => testingModeLogic.turnOnTestingDeletes(null);
