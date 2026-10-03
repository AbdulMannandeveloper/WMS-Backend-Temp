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

/**
 * Codes a client owns: SKUs and product barcodes.
 *
 * Trimmed, and blank is no code at all, but the case is kept. A SKU is the
 * client's own identifier — it is printed on their delivery notes and invoices
 * and matched against their own systems — so rewriting `abc-red` as `ABC-RED`
 * would be changing their data. Instead they are compared without regard to
 * case (equalsIgnoringCase below) and the database refuses two that differ
 * only in case (migration 20261003130000).
 */
const normaliseCode = (value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * A Prisma filter matching `value` exactly, ignoring case.
 *
 * Prisma compiles `{ equals, mode: 'insensitive' }` to ILIKE and passes the
 * value through unescaped, so `_` and `%` in it act as wildcards: a scan of
 * `AB_1` would also match `ABX1`. Escaping them makes it a true equality test.
 */
const equalsIgnoringCase = (value) => ({
  equals: String(value).replace(/[\\%_]/g, '\\$&'),
  mode: 'insensitive',
});

/**
 * Looks a unique code up exactly, and only on a miss ignoring case.
 *
 * For system references (SHP-, BULK-, RET-, FRT-) and freight barcodes. Every
 * internal caller passes the code as stored, so it gets the indexed equality
 * lookup it always had; the ILIKE scan is paid only by a code keyed in another
 * case. The fallback cannot be replaced by uppercasing the input: references
 * written by hand before the generators existed are in whatever case they
 * were typed.
 *
 * @param {(match: string | object) => Promise<object|null>} find
 *   runs the lookup with `match` as the field's filter value
 * @param {string} value
 */
const findExactThenIgnoringCase = async (find, value) =>
  (await find(value)) ?? (await find(equalsIgnoringCase(value)));

module.exports = {
  normaliseEmail,
  normaliseUsername,
  normaliseNiNumber,
  normaliseCode,
  equalsIgnoringCase,
  findExactThenIgnoringCase,
};
