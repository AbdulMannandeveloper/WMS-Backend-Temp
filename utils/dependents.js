'use strict';

/**
 * What still points at a record, and whether that stops it being deleted.
 *
 * Every admin delete in the app follows one rule: a record that other records
 * depend on is not deleted out from under them. The admin is shown what is in
 * the way, clears it first (or deactivates instead), and only then deletes.
 * Before this, the same situation surfaced as a raw foreign-key error from
 * Postgres, or — worse, where the FK cascades — as rows silently disappearing.
 *
 * A report has two lists:
 *
 * - **blocking** — must be gone before the delete is allowed. Each carries the
 *   screen where it is dealt with (`where`), so the UI can send the admin there.
 * - **removedWith** — owned by the record and deleted along with it (an agreed
 *   price list, say). Not a reason to refuse, but the admin is told beforehand.
 *
 * Rows with a count of zero are dropped, so an empty `blocking` means deletable.
 *
 * The same report is served by a `GET /:id/dependents` route — so the warning
 * appears before the admin presses anything — and attached to the 409 a delete
 * answers with, in case something was added in between. The delete builds it
 * again inside its own transaction, after lockForDelete, so nothing can be
 * added between that check and the delete itself.
 */

/**
 * @typedef {object} DependentRow
 * @property {string} key      stable identifier, e.g. "shipments"
 * @property {string} label    what to call them, plural, e.g. "Shipments"
 * @property {number} count
 * @property {string} [where]  app path where these are managed, e.g. "/shipments"
 * @property {string} [note]   one line on how to clear them, when it is not obvious
 */

/**
 * @param {{ blocking?: DependentRow[], removedWith?: DependentRow[] }} rows
 */
const buildReport = ({ blocking = [], removedWith = [] }) => {
  const present = (rows) => rows.filter((row) => row.count > 0);
  const stillBlocking = present(blocking);
  return {
    canDelete: stillBlocking.length === 0,
    blocking: stillBlocking,
    removedWith: present(removedWith),
  };
};

/** Refusal to delete while something still depends on the record. */
class HasDependentsError extends Error {
  constructor(subject, report, { deactivatable = false } = {}) {
    const summary = report.blocking
      .map((row) => `${row.count} ${row.label.toLowerCase()}`)
      .join(', ');
    super(
      `${subject} still has ${summary}. Remove those first${deactivatable ? ', or deactivate it instead' : ''}.`,
    );
    this.status = 409;
    this.code = 'HAS_DEPENDENTS';
    this.dependents = report;
  }
}

/**
 * @param {string} subject  how to name the record in the message, e.g. "Acme Ltd"
 * @param {ReturnType<typeof buildReport>} report
 * @param {{ deactivatable?: boolean }} [options]  whether to point at
 *   deactivating as the alternative — only where the record has an off switch
 * @throws {HasDependentsError} when anything is still blocking
 */
const assertDeletable = (subject, report, options) => {
  if (!report.canDelete) {
    throw new HasDependentsError(subject, report, options);
  }
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Holds a record's row for the rest of a delete's transaction, so what is
 * counted after it is still what there is when the delete commits.
 *
 * Adding a row that names this one by foreign key takes a KEY SHARE lock on
 * it, which FOR UPDATE blocks: whatever would add a dependent waits for the
 * delete, then fails on the missing parent. One that got in first has
 * committed by the time the lock is granted, so the count that follows sees
 * it. An edit to the row itself (a status change, say) waits the same way.
 *
 * `table` and `column` come from the code, never from a request. An id that is
 * not a uuid locks nothing, and the lookup after it answers as it always did.
 */
const lockForDelete = async (tx, table, id, column = 'id') => {
  if (typeof id !== 'string' || !UUID.test(id)) return;
  await tx.$queryRawUnsafe(`SELECT 1 FROM "${table}" WHERE "${column}" = $1::uuid FOR UPDATE`, id);
};

/** The 409 body a controller sends for a HasDependentsError. */
const dependentsBody = (err) => ({
  error: err.message,
  code: err.code,
  dependents: err.dependents,
});

module.exports = { buildReport, assertDeletable, lockForDelete, HasDependentsError, dependentsBody };
