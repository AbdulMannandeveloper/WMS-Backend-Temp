'use strict';

/**
 * Month and day boundaries, always in UTC.
 *
 * Several columns here are `@db.Date` — billing_period, month_year, date. Prisma
 * stores those from the Date's UTC calendar day, so building a month boundary
 * with local-time constructors silently files the row under the wrong month
 * anywhere east of UTC:
 *
 *     new Date(2026, 7, 1)        // UTC+5 -> 2026-07-31T19:00Z -> stored 2026-07-31
 *     Date.UTC(2026, 7, 1)        //         2026-08-01T00:00Z -> stored 2026-08-01
 *
 * That is not academic: it put two rows in monthly_invoices for the same August,
 * one written by the API and one by dispatch, which the unique constraint on
 * (client, billing_period) could not catch because the dates genuinely differed.
 *
 * Use these everywhere a month or a calendar day is derived. The equivalent for
 * attendance already lives in logic/attendance_log.logic.js as toUtcDateOnly.
 */

/** Midnight UTC on the 1st of the month containing `dateInput` (default: now). */
const firstOfMonthUtc = (dateInput) => {
  const d = dateInput ? new Date(dateInput) : new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

/** Last instant of that month, for inclusive `lte` range bounds. */
const endOfMonthUtc = (dateInput) => {
  const d = dateInput ? new Date(dateInput) : new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999)
  );
};

/** Last calendar day of that month at midnight UTC, for `@db.Date` bounds. */
const lastDayOfMonthUtc = (dateInput) => {
  const d = dateInput ? new Date(dateInput) : new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
};

/** Shifts by whole months, normalised to the 1st. Negative counts go back. */
const addMonthsUtc = (dateInput, count) => {
  const d = dateInput ? new Date(dateInput) : new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + count, 1));
};

/** Midnight UTC on the calendar day of `dateInput`. */
const toUtcDateOnly = (dateInput) => {
  const d = dateInput ? new Date(dateInput) : new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

module.exports = {
  firstOfMonthUtc,
  endOfMonthUtc,
  lastDayOfMonthUtc,
  addMonthsUtc,
  toUtcDateOnly,
};
