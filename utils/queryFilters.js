'use strict';

/**
 * Query-string coercion for list endpoints.
 *
 * Everything in req.query is a string, or an array of strings when a parameter
 * repeats. Handing those straight to Prisma is how a typo becomes a 500: a
 * malformed uuid raises P2023, `new Date('yesterday')` becomes Invalid Date and
 * silently matches nothing at all, and an unrecognised enum label reaches
 * Postgres as a value its type does not contain. Each of those is a bad
 * request, and should read like one.
 *
 * Two rules the rest of this file exists to enforce:
 *
 *   1. DATE BOUNDS ARE UTC. utils/dates.js already carries the scar tissue —
 *      a local-time month boundary once filed two invoices under the same
 *      August, which the unique constraint could not catch because the dates
 *      genuinely differed. logic/inventory_ledger.logic.js still builds its end
 *      bound with local setHours, which is the same bug waiting for a server in
 *      a different timezone. Everything below uses Date.UTC.
 *
 *   2. THE END BOUND DEPENDS ON THE COLUMN, NOT THE ENDPOINT. A @db.Date column
 *      stores midnight, so `lte: 2026-08-15T00:00Z` already covers the whole of
 *      the 15th. A @db.Timestamptz column stores a moment, so the same bound
 *      drops everything after midnight. The ledger extends its end bound and
 *      expenses does not; `granularity` is the deliberate resolution of that
 *      inconsistency rather than a third opinion on it.
 */

const { parsePagination } = require('./pagination');
const { firstOfMonthUtc, lastDayOfMonthUtc } = require('./dates');

/** A bad request, carrying the status the controller should answer with. */
class QueryParamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueryParamError';
    // `err.status` is the convention product.logic.deleteProduct already uses.
    this.status = 400;
  }
}

const isBlank = (value) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '');

/** Express hands over an array when a parameter repeats; scalars take the first. */
const first = (value) => (Array.isArray(value) ? value[0] : value);

// ─── Dates ────────────────────────────────────────────────────────────────────

const toDate = (value, label) => {
  const raw = first(value);
  const parsed = raw instanceof Date ? raw : new Date(String(raw).trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new QueryParamError(`${label} is not a valid date.`);
  }
  return parsed;
};

/**
 * 'YYYY-MM-DD' is parsed as UTC by the language spec, so the getUTC* reads below
 * give back the day the caller typed. A full datetime carrying an offset is
 * converted to its UTC calendar day — documented behaviour rather than an
 * accident, and the reason a bound is never built from local getters.
 */
const startOfUtcDay = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const endOfUtcDay = (d) =>
  new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999),
  );

/**
 * An inclusive range for a Prisma date filter, or undefined when neither bound
 * was given.
 *
 * @param {'timestamp'|'date'|'month'} granularity - how the column stores time:
 *   timestamp  @db.Timestamptz — gte start of day UTC, lte 23:59:59.999 UTC
 *   date       @db.Date        — both bounds at midnight UTC
 *   month      @db.Date holding the 1st (billingPeriod, monthYear) — gte the 1st
 *              of the start month, lte the last day of the end month
 */
const dateRangeFilter = (
  startValue,
  endValue,
  { granularity = 'timestamp', startLabel = 'startDate', endLabel = 'endDate' } = {},
) => {
  const range = {};

  if (!isBlank(startValue)) {
    const start = toDate(startValue, startLabel);
    range.gte = granularity === 'month' ? firstOfMonthUtc(start) : startOfUtcDay(start);
  }

  if (!isBlank(endValue)) {
    const end = toDate(endValue, endLabel);
    if (granularity === 'month') range.lte = lastDayOfMonthUtc(end);
    else if (granularity === 'date') range.lte = startOfUtcDay(end);
    else range.lte = endOfUtcDay(end);
  }

  if (range.gte && range.lte && range.gte > range.lte) {
    throw new QueryParamError(`${startLabel} must not be after ${endLabel}.`);
  }

  return Object.keys(range).length > 0 ? range : undefined;
};

// ─── Enums ────────────────────────────────────────────────────────────────────

/**
 * One allowed label, or `{ in: [...] }` for a comma-separated list of them.
 *
 * The allowlist is the entire point: these reach Prisma as values in a Postgres
 * enum type, where an unrecognised label is a database error rather than an
 * empty result.
 */
const parseEnum = (value, allowed, { label = 'value', multiple = true } = {}) => {
  if (isBlank(value)) return undefined;

  const tokens = []
    .concat(value)
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (tokens.length === 0) return undefined;

  for (const token of tokens) {
    if (!allowed.includes(token)) {
      throw new QueryParamError(`${label} must be one of: ${allowed.join(', ')}.`);
    }
  }

  if (!multiple && tokens.length > 1) {
    throw new QueryParamError(`${label} accepts a single value.`);
  }

  const unique = [...new Set(tokens)];
  return unique.length === 1 ? unique[0] : { in: unique };
};

// ─── Numbers and decimals ─────────────────────────────────────────────────────

/**
 * Validates numerically, returns the ORIGINAL string.
 *
 * Money columns are numeric(14,2) and Prisma takes a string straight through to
 * Decimal. Returning Number('0.1') would put a float on one side of a
 * comparison against exact decimals — the same class of mistake the invoice
 * total comments warn about at length.
 */
const parseDecimal = (value, label) => {
  if (isBlank(value)) return undefined;
  const raw = String(first(value)).trim();
  if (!Number.isFinite(Number(raw))) {
    throw new QueryParamError(`${label} must be a number.`);
  }
  return raw;
};

const parseInteger = (value, label) => {
  if (isBlank(value)) return undefined;
  const parsed = Number(String(first(value)).trim());
  if (!Number.isInteger(parsed)) {
    throw new QueryParamError(`${label} must be a whole number.`);
  }
  return parsed;
};

/** `{ gte, lte }` from a <field>Min / <field>Max pair, or undefined. */
const rangeFilter = (minValue, maxValue, { label, integer = false } = {}) => {
  const parse = integer ? parseInteger : parseDecimal;
  const range = {};

  const min = parse(minValue, `${label}Min`);
  const max = parse(maxValue, `${label}Max`);
  if (min !== undefined) range.gte = min;
  if (max !== undefined) range.lte = max;

  if (
    range.gte !== undefined &&
    range.lte !== undefined &&
    Number(range.gte) > Number(range.lte)
  ) {
    throw new QueryParamError(`${label}Min must not be greater than ${label}Max.`);
  }

  return Object.keys(range).length > 0 ? range : undefined;
};

// ─── Booleans, ids, strings ───────────────────────────────────────────────────

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

const parseBoolean = (value, label) => {
  if (isBlank(value)) return undefined;
  const raw = String(first(value)).trim().toLowerCase();
  if (TRUTHY.has(raw)) return true;
  if (FALSY.has(raw)) return false;
  throw new QueryParamError(`${label} must be true or false.`);
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A uuid, or undefined.
 *
 * Checked here rather than at the database, because Prisma's P2023 for a
 * malformed uuid surfaces as a 500 carrying the column name — an error that
 * tells someone probing more than it tells the operator.
 */
const parseUuid = (value, label) => {
  if (isBlank(value)) return undefined;
  const raw = String(first(value)).trim();
  if (!UUID_RE.test(raw)) {
    throw new QueryParamError(`${label} is not a valid id.`);
  }
  return raw;
};

const parseString = (value, { label = 'value', maxLength = 200 } = {}) => {
  if (isBlank(value)) return undefined;
  const raw = String(first(value)).trim();
  if (raw.length > maxLength) {
    throw new QueryParamError(`${label} must be ${maxLength} characters or fewer.`);
  }
  return raw;
};

// ─── Free-text search ─────────────────────────────────────────────────────────

/**
 * Nests a dotted path into a Prisma where clause.
 *
 *   'client.companyName'               -> { client: { companyName: leaf } }
 *   'shipmentItems[].product.skuCode'  -> { shipmentItems: { some: { product: { skuCode: leaf } } } }
 *
 * The [] marker is needed because a to-many relation takes some/every/none and
 * a to-one does not. Getting it wrong is a Prisma validation error at runtime,
 * which means it surfaces only on the endpoint nobody clicked.
 */
const nestPath = (path, leaf) =>
  path.split('.').reduceRight((acc, segment) => {
    if (segment.endsWith('[]')) {
      return { [segment.slice(0, -2)]: { some: acc } };
    }
    return { [segment]: acc };
  }, leaf);

/**
 * OR of case-insensitive `contains` across the given paths.
 *
 * Compiles to ILIKE '%term%'. A leading wildcard means no btree index can serve
 * it, so this is a sequential scan by construction — see the index migration
 * for the note on when that stops being acceptable.
 */
const searchFilter = (value, paths, { label = 'search' } = {}) => {
  const term = parseString(value, { label, maxLength: 128 });
  if (!term) return undefined;
  return {
    OR: paths.map((path) => nestPath(path, { contains: term, mode: 'insensitive' })),
  };
};

/**
 * "John Smith" against separate firstName / lastName columns.
 *
 * A plain `contains` on either column never matches a full name, which is
 * exactly what someone types into a search box. Splitting on whitespace and
 * ANDing the halves across the two columns — in both orders, because nobody
 * agrees which way round a name goes — covers it.
 *
 * @param {string} relationPath - '' for a User row itself, or e.g. 'createdBy'
 */
const personNameFilter = (value, relationPath, { label = 'search' } = {}) => {
  const term = parseString(value, { label, maxLength: 128 });
  if (!term) return undefined;

  const at = (field, contains) =>
    relationPath
      ? nestPath(`${relationPath}.${field}`, { contains, mode: 'insensitive' })
      : { [field]: { contains, mode: 'insensitive' } };

  const clauses = [at('firstName', term), at('lastName', term)];

  const parts = term.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const [head, ...tail] = parts;
    const rest = tail.join(' ');
    clauses.push({ AND: [at('firstName', head), at('lastName', rest)] });
    clauses.push({ AND: [at('firstName', rest), at('lastName', head)] });
  }

  return { OR: clauses };
};

// ─── Sorting ──────────────────────────────────────────────────────────────────

/**
 * @param {object} spec
 *   spec.allowed     - { publicName: (order) => prismaOrderBy | prismaOrderBy[] }
 *   spec.defaultSort - { field, order }
 *   spec.tiebreaker  - orderBy[] appended to every result. Never empty.
 *
 * The tiebreaker is not decoration. Postgres promises nothing about the order of
 * rows that compare equal, so OFFSET/LIMIT over a non-unique sort key can hand
 * back the same row on two pages and never hand back another. Several tables
 * here have no date column at all, and several have no ORDER BY today — their
 * page 2 is currently undefined behaviour rather than a wrong answer.
 *
 * An unknown sortBy is refused rather than ignored: a sort that silently does
 * not happen is a worse bug to chase than one that says so.
 */
const parseSort = (query = {}, spec = {}) => {
  const { allowed = {}, defaultSort, tiebreaker } = spec;

  if (!defaultSort || !Array.isArray(tiebreaker) || tiebreaker.length === 0) {
    throw new Error('parseSort requires defaultSort and a non-empty tiebreaker.');
  }

  let field = defaultSort.field;
  let order = defaultSort.order;

  const requestedOrder = first(query.sortOrder);
  if (!isBlank(requestedOrder)) {
    const normalised = String(requestedOrder).trim().toLowerCase();
    if (normalised !== 'asc' && normalised !== 'desc') {
      throw new QueryParamError("sortOrder must be 'asc' or 'desc'.");
    }
    order = normalised;
  }

  const requestedField = first(query.sortBy);
  if (!isBlank(requestedField)) {
    field = String(requestedField).trim();
    if (!Object.prototype.hasOwnProperty.call(allowed, field)) {
      throw new QueryParamError(
        `sortBy must be one of: ${Object.keys(allowed).sort().join(', ')}.`,
      );
    }
  }

  const build = allowed[field];
  if (!build) {
    // A spec whose own default is not in its allowlist is a programming error,
    // not a bad request — so this is an Error, not a QueryParamError.
    throw new Error(`Sort spec is missing its default field '${field}'.`);
  }

  const primary = build(order);
  return [...(Array.isArray(primary) ? primary : [primary]), ...tiebreaker];
};

// ─── Assembly ─────────────────────────────────────────────────────────────────

/**
 * The single call every list endpoint makes — and, for its `where` alone, every
 * /summary endpoint beside it.
 *
 * Filters are combined with AND rather than merged into one object. Two filters
 * that both produce an `OR` — a text search and a relation predicate, say —
 * would otherwise overwrite each other, and the one that lost would simply stop
 * applying. A filter that quietly does nothing is how a client ends up seeing
 * another client's rows.
 *
 * `where` derives from spec.filters alone: page, limit, sortBy and sortOrder
 * never touch it. That is what lets a /summary handler pass the same query here
 * and be certain it is aggregating over exactly the rows the list is paging.
 */
const buildListQuery = (query = {}, spec = {}) => {
  const clauses = [];
  for (const build of spec.filters || []) {
    const clause = build(query);
    if (clause) clauses.push(clause);
  }

  const where =
    clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { AND: clauses };

  return {
    where,
    orderBy: parseSort(query, spec.sort),
    pagination: parsePagination(query),
  };
};

/**
 * Applies a tenant scope as an outer AND, after every caller-supplied filter.
 *
 * Deliberately not a spread. `{ ...where, clientId }` looks equivalent and is
 * not: when a filter has already set clientId, or built an AND of its own, key
 * order decides which one survives. Wrapping means no query string can widen
 * the scope, whatever it contains.
 */
const withScope = (where, scope) =>
  scope ? { AND: [where || {}, scope] } : where || {};

module.exports = {
  QueryParamError,
  dateRangeFilter,
  parseEnum,
  parseDecimal,
  parseInteger,
  rangeFilter,
  parseBoolean,
  parseUuid,
  parseString,
  searchFilter,
  personNameFilter,
  nestPath,
  parseSort,
  buildListQuery,
  withScope,
};
