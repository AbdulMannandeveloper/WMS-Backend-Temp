/**
 * The one spelling each identifier is stored and looked up in.
 *
 * Postgres compares text exactly, so `John@Acme.com` and `john@acme.com` are
 * two different rows to a unique index and a miss to a lookup. Users do not
 * see them as different: the login refused anyone who typed their address in
 * another case, forgot-password silently sent nothing, and the duplicate check
 * let one mailbox own two accounts.
 *
 * Every write and every lookup goes through these, and the database holds the
 * same rule as a CHECK constraint (migration 20261003120000), so a path that
 * forgets fails loudly instead of storing a row nobody can find.
 *
 * Non-strings pass through untouched: validation that rejects a missing or
 * malformed value belongs to the caller, and should see what was sent.
 */

/** Emails: trimmed, lowercase. */
const normaliseEmail = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Usernames: trimmed, lowercase, and blank is no username at all.
 *
 * Blank becomes null because the column is unique: a second empty string
 * would collide with the first, where any number of nulls may coexist.
 */
const normaliseUsername = (value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
};

/**
 * National Insurance numbers: uppercase, no spaces.
 *
 * HMRC prints them as `QQ 12 34 56 C` and people type them every way in
 * between. The column is unique, so each variant would otherwise be a separate
 * person to the database.
 */
const normaliseNiNumber = (value) => {
  if (typeof value !== 'string') return value;
  const compact = value.replace(/\s+/g, '').toUpperCase();
  return compact === '' ? null : compact;
};

module.exports = {
  normaliseEmail,
  normaliseUsername,
  normaliseNiNumber,
};
