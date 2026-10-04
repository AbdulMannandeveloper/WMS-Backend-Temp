'use strict';

/**
 * The two state machines the module turns on: a box's status, and the flight
 * status derived from its boxes.
 *
 * A box moves only through a scan or a recorded action, never by someone editing
 * a status field — the one exception is the admin override, which records a
 * reason. `BOX_TRANSITIONS` is the whitelist every move is checked against, so
 * an impossible move (a handed-over box going back to manifested) is a thrown
 * error rather than a quietly corrupt row.
 *
 * The flight status is not authored at all after dispatch: `recomputeFlightStatus`
 * works it out from the box counts and the milestone timestamps every time a box
 * changes, so the list filter and the client's progress bar always agree with
 * the boxes underneath them. DRAFT, DISPATCHED and CANCELLED are the only states
 * an action sets directly.
 *
 * These constants are required by the box repository (for the active-tracking
 * predicate), so this module must not require the box repository at load time —
 * recomputeFlightStatus pulls it in lazily.
 */

// ─── Box status sets ──────────────────────────────────────────────────────────

/**
 * The statuses a box's tracking number is "live" in. Matches the partial unique
 * index predicate exactly (migration 20261005120000): a finished box must not
 * hold a recycled number forever.
 */
const ACTIVE_BOX_STATUSES = [
  'MANIFESTED',
  'DISPATCHED',
  'LANDED',
  'CUSTOMS_HOLD',
  'CLEARED',
  'RECEIVED',
  'ON_HOLD',
  'ON_HANDOVER',
  'SHORT',
  'REFUSED_AT_DEPOT',
];

/** Nothing moves out of these. */
const TERMINAL_BOX_STATUSES = ['HANDED_TO_COURIER', 'RETURNED_TO_CLIENT', 'WRITTEN_OFF', 'CANCELLED'];

/** A receive scan accepts a box in one of these. */
const RECEIVABLE_BOX_STATUSES = ['DISPATCHED', 'LANDED', 'CLEARED', 'SHORT'];

// ─── Box transitions (§1G) ──────────────────────────────────────────────────────

/** from → allowed to[]. The admin override may reach any non-refused target. */
const BOX_TRANSITIONS = {
  MANIFESTED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['LANDED', 'RECEIVED', 'SHORT', 'CANCELLED'],
  LANDED: ['CUSTOMS_HOLD', 'CLEARED', 'RECEIVED', 'SHORT', 'CANCELLED'],
  CUSTOMS_HOLD: ['LANDED', 'CLEARED', 'RECEIVED'],
  CLEARED: ['CUSTOMS_HOLD', 'RECEIVED', 'SHORT', 'CANCELLED'],
  RECEIVED: ['CUSTOMS_HOLD', 'ON_HOLD', 'ON_HANDOVER', 'RETURNED_TO_CLIENT'],
  ON_HOLD: ['RECEIVED', 'RETURNED_TO_CLIENT'],
  ON_HANDOVER: ['HANDED_TO_COURIER', 'REFUSED_AT_DEPOT', 'RECEIVED'],
  SHORT: ['RECEIVED', 'WRITTEN_OFF'],
  REFUSED_AT_DEPOT: ['RECEIVED', 'RETURNED_TO_CLIENT'],
  HANDED_TO_COURIER: [],
  RETURNED_TO_CLIENT: [],
  WRITTEN_OFF: [],
  CANCELLED: [],
};

const isTerminal = (status) => TERMINAL_BOX_STATUSES.includes(status);
const isReceivable = (status) => RECEIVABLE_BOX_STATUSES.includes(status);

/**
 * Throws unless a box may move from `from` to `to`. A no-op move (from === to)
 * is allowed so an idempotent action does not have to special-case it.
 */
const assertBoxTransition = (from, to) => {
  if (from === to) return;
  const allowed = BOX_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`A box cannot move from ${from} to ${to}.`);
  }
};

// ─── Flight status (§1G) ────────────────────────────────────────────────────────

/**
 * Works out a flight's status from its box counts and milestones. Pure given the
 * two inputs — exported on its own so it can be unit-tested without a database.
 *
 * @param {{status, landedAt, clearedAt, receiptClosedAt}} flight
 * @param {Record<string, number>} counts  box status → count, over ALL boxes
 * @returns {{ status: string, completed: boolean }}
 */
const deriveFlightStatus = (flight, counts) => {
  if (flight.status === 'DRAFT' || flight.status === 'CANCELLED') {
    return { status: flight.status, completed: false };
  }

  const active = { ...counts };
  const cancelled = active.CANCELLED ?? 0;
  const total = Object.values(active).reduce((sum, n) => sum + n, 0);

  // Every box cancelled — the flight is cancelled too.
  if (total > 0 && total === cancelled) return { status: 'CANCELLED', completed: false };

  const nonCancelled = total - cancelled;
  const terminalCount = TERMINAL_BOX_STATUSES.reduce((sum, s) => sum + (active[s] ?? 0), 0);
  const allTerminal = nonCancelled > 0 && terminalCount === total;

  if (flight.receiptClosedAt && allTerminal) return { status: 'COMPLETED', completed: true };

  const anyOf = (...statuses) => statuses.some((s) => (active[s] ?? 0) > 0);

  if (anyOf('ON_HANDOVER', 'HANDED_TO_COURIER')) return { status: 'IN_DELIVERY', completed: false };
  if (flight.receiptClosedAt) {
    return { status: (active.SHORT ?? 0) > 0 ? 'RECEIVED_PARTIAL' : 'RECEIVED', completed: false };
  }
  if (anyOf('RECEIVED', 'ON_HOLD')) return { status: 'RECEIVING', completed: false };
  if (anyOf('CUSTOMS_HOLD')) return { status: 'CUSTOMS_HOLD', completed: false };
  if (flight.clearedAt) return { status: 'CLEARED', completed: false };
  if (flight.landedAt) return { status: 'LANDED', completed: false };
  return { status: 'DISPATCHED', completed: false };
};

/**
 * Recomputes and persists a flight's status from its boxes, inside the caller's
 * transaction. Run after every box change. Returns the new status.
 *
 * On reaching COMPLETED it stamps completedAt and promotes billing NOT_READY →
 * READY; on leaving COMPLETED (an override reopened a box) it resets billing
 * READY → NOT_READY. A POSTED flight never leaves COMPLETED, because overrides
 * are refused while POSTED.
 */
const recomputeFlightStatus = async (flightId, tx) => {
  // Required lazily: the box repository requires this module for its constants.
  const flightRepository = require('../repositories/air_freight_flight.repository');
  const boxRepository = require('../repositories/air_freight_box.repository');

  const flight = await flightRepository.getFlightCore(flightId, tx);
  if (!flight) return null;
  if (flight.status === 'DRAFT' || flight.status === 'CANCELLED') return flight.status;

  const counts = await boxRepository.countsByStatus(flightId, tx);
  const { status, completed } = deriveFlightStatus(flight, counts);

  const data = { status };
  if (completed) {
    if (!flight.completedAt) data.completedAt = new Date();
    if (flight.billingStatus === 'NOT_READY') data.billingStatus = 'READY';
  } else if (flight.status === 'COMPLETED') {
    // Leaving COMPLETED: a reopened box. Billing was READY (POSTED is impossible
    // here), so drop it back.
    data.completedAt = null;
    if (flight.billingStatus === 'READY') data.billingStatus = 'NOT_READY';
  }

  await flightRepository.updateFlight(flightId, data, tx);
  return status;
};

module.exports = {
  ACTIVE_BOX_STATUSES,
  TERMINAL_BOX_STATUSES,
  RECEIVABLE_BOX_STATUSES,
  BOX_TRANSITIONS,
  isTerminal,
  isReceivable,
  assertBoxTransition,
  deriveFlightStatus,
  recomputeFlightStatus,
};
