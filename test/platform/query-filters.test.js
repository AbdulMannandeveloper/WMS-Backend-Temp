/**
 * The query-string coercion every list endpoint runs on.
 *
 * Pure functions, no database — so this file can cover the edge cases
 * exhaustively at a cost the integration suite could not afford. What is being
 * pinned here is mostly the behaviour of malformed input: a list endpoint's
 * filters are the part of the API a person reaches by typing, and the failure
 * mode that matters is a parameter that silently does nothing.
 */

import { describe, it, expect } from 'vitest';

import {
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
} from '../../utils/queryFilters.js';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_UUID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

// A minimal spec, shaped like the real ones.
const SPEC = {
  filters: [
    (q) => (q.status ? { status: parseEnum(q.status, ['DRAFT', 'PAID'], { label: 'status' }) } : undefined),
    (q) => {
      const range = dateRangeFilter(q.startDate, q.endDate, { granularity: 'date' });
      return range ? { date: range } : undefined;
    },
    (q) => searchFilter(q.search, ['description', 'client.companyName']),
  ],
  sort: {
    allowed: {
      date: (order) => ({ date: order }),
      amount: (order) => ({ amount: order }),
      clientName: (order) => ({ client: { companyName: order } }),
    },
    defaultSort: { field: 'date', order: 'desc' },
    tiebreaker: [{ id: 'asc' }],
  },
};

describe('dateRangeFilter', () => {
  it('reads a date-only string as the day the caller typed, in UTC', () => {
    // The whole point of the helper: a local-time reading of this string is a
    // different calendar day anywhere east of UTC, and this machine runs UTC+5.
    const range = dateRangeFilter('2026-08-15', undefined, { granularity: 'date' });

    expect(range.gte.toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });

  it('extends the end bound to the last instant of the day for a timestamp column', () => {
    const range = dateRangeFilter(undefined, '2026-08-15', { granularity: 'timestamp' });

    expect(range.lte.toISOString()).toBe('2026-08-15T23:59:59.999Z');
  });

  it('leaves the end bound at midnight for a date column', () => {
    // A @db.Date column stores midnight, so the whole of the 15th is already
    // covered. Extending it would be harmless but would misrepresent the column.
    const range = dateRangeFilter(undefined, '2026-08-15', { granularity: 'date' });

    expect(range.lte.toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });

  it('widens a month range to the whole months at both ends', () => {
    const range = dateRangeFilter('2026-03-14', '2026-05-02', { granularity: 'month' });

    expect(range.gte.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(range.lte.toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });

  it('is undefined when neither bound is given', () => {
    expect(dateRangeFilter(undefined, undefined)).toBeUndefined();
    expect(dateRangeFilter('', '   ')).toBeUndefined();
  });

  it('refuses a date it cannot parse', () => {
    expect(() => dateRangeFilter('yesterday', undefined)).toThrow(QueryParamError);
    // Without this the value becomes Invalid Date and matches nothing at all —
    // an empty table rather than an error message.
    expect(() => dateRangeFilter('yesterday', undefined)).toThrow(/startDate/);
  });

  it('refuses a range that runs backwards', () => {
    expect(() => dateRangeFilter('2026-08-15', '2026-08-01')).toThrow(
      /must not be after/,
    );
  });
});

describe('parseEnum', () => {
  it('returns a bare value for one label', () => {
    expect(parseEnum('DRAFT', ['DRAFT', 'PAID'])).toBe('DRAFT');
  });

  it('returns an in-clause for a comma-separated list', () => {
    expect(parseEnum('DRAFT,PAID', ['DRAFT', 'PAID'])).toEqual({
      in: ['DRAFT', 'PAID'],
    });
  });

  it('collapses duplicates to a bare value', () => {
    expect(parseEnum('DRAFT,DRAFT', ['DRAFT', 'PAID'])).toBe('DRAFT');
  });

  it('refuses a label the column does not have', () => {
    // This reaches Postgres as a value in an enum type, where an unknown label
    // is a database error rather than an empty result.
    expect(() => parseEnum('NOPE', ['DRAFT', 'PAID'], { label: 'status' })).toThrow(
      /status must be one of: DRAFT, PAID/,
    );
  });

  it('can refuse a list where only one value makes sense', () => {
    expect(() =>
      parseEnum('DRAFT,PAID', ['DRAFT', 'PAID'], { multiple: false }),
    ).toThrow(/single value/);
  });
});

describe('parseDecimal', () => {
  it('returns the original string, not a number', () => {
    // Money columns are numeric(14,2) and Prisma takes the string straight to
    // Decimal. Returning Number('0.10') would put a float on one side of a
    // comparison against exact decimals.
    const parsed = parseDecimal('0.10', 'amountMin');

    expect(parsed).toBe('0.10');
    expect(typeof parsed).toBe('string');
  });

  it('refuses something that is not a number', () => {
    expect(() => parseDecimal('abc', 'amountMin')).toThrow(/amountMin must be a number/);
  });
});

describe('parseInteger', () => {
  it('refuses a fractional count', () => {
    expect(() => parseInteger('1.5', 'countMin')).toThrow(/whole number/);
  });

  it('accepts a negative whole number', () => {
    expect(parseInteger('-3', 'countMin')).toBe(-3);
  });
});

describe('rangeFilter', () => {
  it('builds gte/lte from a Min/Max pair', () => {
    expect(rangeFilter('10', '20', { label: 'amount' })).toEqual({
      gte: '10',
      lte: '20',
    });
  });

  it('allows one open end', () => {
    expect(rangeFilter('10', undefined, { label: 'amount' })).toEqual({ gte: '10' });
  });

  it('refuses a range that runs backwards', () => {
    expect(() => rangeFilter('20', '10', { label: 'amount' })).toThrow(
      /amountMin must not be greater than amountMax/,
    );
  });

  it('compares numerically, not as strings', () => {
    // '9' > '10' lexically; the guard must not fire here.
    expect(() => rangeFilter('9', '10', { label: 'amount' })).not.toThrow();
  });
});

describe('parseBoolean', () => {
  it('accepts the spellings a query string actually carries', () => {
    for (const truthy of ['true', '1', 'yes', 'on', 'TRUE']) {
      expect(parseBoolean(truthy, 'flag')).toBe(true);
    }
    for (const falsy of ['false', '0', 'no', 'off', 'FALSE']) {
      expect(parseBoolean(falsy, 'flag')).toBe(false);
    }
  });

  it('distinguishes absent from false', () => {
    // undefined means "do not filter"; false means "filter to false". Collapsing
    // the two would make ?isDeactivated= mean something.
    expect(parseBoolean(undefined, 'flag')).toBeUndefined();
    expect(parseBoolean('false', 'flag')).toBe(false);
  });

  it('refuses anything else', () => {
    expect(() => parseBoolean('maybe', 'flag')).toThrow(/flag must be true or false/);
  });
});

describe('parseUuid', () => {
  it('passes a well-formed id through', () => {
    expect(parseUuid(UUID, 'clientId')).toBe(UUID);
  });

  it('refuses a malformed id before Prisma sees it', () => {
    // Prisma's P2023 surfaces as a 500 carrying the column name, which tells
    // someone probing more than it tells the operator.
    expect(() => parseUuid('not-an-id', 'clientId')).toThrow(
      /clientId is not a valid id/,
    );
    expect(() => parseUuid('not-an-id', 'clientId')).toThrow(QueryParamError);
  });
});

describe('parseString', () => {
  it('trims', () => {
    expect(parseString('  hello  ')).toBe('hello');
  });

  it('refuses one longer than the cap', () => {
    expect(() => parseString('x'.repeat(201), { label: 'search' })).toThrow(
      /200 characters or fewer/,
    );
  });
});

describe('nestPath', () => {
  it('nests a to-one relation', () => {
    expect(nestPath('client.companyName', { contains: 'acme' })).toEqual({
      client: { companyName: { contains: 'acme' } },
    });
  });

  it('nests a to-many relation as `some`', () => {
    // A to-many takes some/every/none and a to-one does not; getting it wrong is
    // a runtime Prisma error on whichever endpoint nobody clicked.
    expect(nestPath('shipmentItems[].product.skuCode', { equals: 'A' })).toEqual({
      shipmentItems: { some: { product: { skuCode: { equals: 'A' } } } },
    });
  });
});

describe('searchFilter', () => {
  it('ORs a case-insensitive contains across every path', () => {
    expect(searchFilter('acme', ['description', 'client.companyName'])).toEqual({
      OR: [
        { description: { contains: 'acme', mode: 'insensitive' } },
        { client: { companyName: { contains: 'acme', mode: 'insensitive' } } },
      ],
    });
  });

  it('is undefined for a blank term, so an empty box filters nothing', () => {
    expect(searchFilter('   ', ['description'])).toBeUndefined();
  });
});

describe('personNameFilter', () => {
  it('matches either column for a single word', () => {
    const filter = personNameFilter('smith', '');

    expect(filter.OR).toHaveLength(2);
    expect(filter.OR[0]).toEqual({
      firstName: { contains: 'smith', mode: 'insensitive' },
    });
  });

  it('splits a full name across the two columns, both ways round', () => {
    // A plain contains on either column never matches "John Smith", which is
    // exactly what someone types into a search box.
    const filter = personNameFilter('John Smith', '');

    expect(filter.OR).toHaveLength(4);
    expect(filter.OR).toContainEqual({
      AND: [
        { firstName: { contains: 'John', mode: 'insensitive' } },
        { lastName: { contains: 'Smith', mode: 'insensitive' } },
      ],
    });
    expect(filter.OR).toContainEqual({
      AND: [
        { firstName: { contains: 'Smith', mode: 'insensitive' } },
        { lastName: { contains: 'John', mode: 'insensitive' } },
      ],
    });
  });

  it('nests under a relation when given one', () => {
    const filter = personNameFilter('smith', 'createdBy');

    expect(filter.OR[0]).toEqual({
      createdBy: { firstName: { contains: 'smith', mode: 'insensitive' } },
    });
  });
});

describe('parseSort', () => {
  it('appends the tiebreaker to every result', () => {
    // Postgres promises nothing about rows that compare equal, so OFFSET/LIMIT
    // over a non-unique key can repeat one row across pages and drop another.
    expect(parseSort({}, SPEC.sort)).toEqual([{ date: 'desc' }, { id: 'asc' }]);
  });

  it('honours an allowed sortBy', () => {
    expect(parseSort({ sortBy: 'amount' }, SPEC.sort)).toEqual([
      { amount: 'desc' },
      { id: 'asc' },
    ]);
  });

  it('honours sortOrder', () => {
    expect(parseSort({ sortBy: 'amount', sortOrder: 'asc' }, SPEC.sort)).toEqual([
      { amount: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('expands a relation sort', () => {
    expect(parseSort({ sortBy: 'clientName' }, SPEC.sort)).toEqual([
      { client: { companyName: 'desc' } },
      { id: 'asc' },
    ]);
  });

  it('refuses an unknown sortBy rather than ignoring it', () => {
    // A sort that silently does not happen is a worse bug to chase than one
    // that says so.
    expect(() => parseSort({ sortBy: 'passwordHash' }, SPEC.sort)).toThrow(
      QueryParamError,
    );
    expect(() => parseSort({ sortBy: 'passwordHash' }, SPEC.sort)).toThrow(
      /sortBy must be one of: amount, clientName, date/,
    );
  });

  it('refuses a raw relation path, so the allowlist cannot be stepped around', () => {
    expect(() => parseSort({ sortBy: 'client.companyName' }, SPEC.sort)).toThrow(
      QueryParamError,
    );
  });

  it('refuses a sortOrder that is neither asc nor desc', () => {
    expect(() => parseSort({ sortOrder: 'sideways' }, SPEC.sort)).toThrow(
      /sortOrder must be/,
    );
  });

  it('treats a spec with no tiebreaker as a programming error, not a bad request', () => {
    const broken = { allowed: SPEC.sort.allowed, defaultSort: { field: 'date', order: 'desc' } };

    expect(() => parseSort({}, broken)).toThrow(/non-empty tiebreaker/);
    expect(() => parseSort({}, broken)).not.toThrow(QueryParamError);
  });
});

describe('buildListQuery', () => {
  it('returns an empty where when nothing is filtered', () => {
    const { where } = buildListQuery({}, SPEC);

    expect(where).toEqual({});
  });

  it('returns the clause bare when only one filter applies', () => {
    const { where } = buildListQuery({ status: 'DRAFT' }, SPEC);

    expect(where).toEqual({ status: 'DRAFT' });
  });

  it('ANDs several filters instead of merging them', () => {
    // Merging would let two filters that both produce an OR overwrite each
    // other, and the one that lost would simply stop applying.
    const { where } = buildListQuery({ status: 'DRAFT', search: 'acme' }, SPEC);

    expect(where.AND).toHaveLength(2);
    expect(where.AND[0]).toEqual({ status: 'DRAFT' });
    expect(where.AND[1].OR).toHaveLength(2);
  });

  it('derives where from the filters alone — paging and sorting never touch it', () => {
    // This is the property the /summary endpoints rest on: same query string,
    // same where, so a summary aggregates over exactly the rows the list pages.
    const query = { status: 'DRAFT', search: 'acme', startDate: '2026-01-01' };

    expect(buildListQuery(query, SPEC).where).toEqual(
      buildListQuery(
        { ...query, page: '3', limit: '7', sortBy: 'amount', sortOrder: 'asc' },
        SPEC,
      ).where,
    );
  });

  it('carries pagination through', () => {
    const { pagination } = buildListQuery({ page: '2', limit: '10' }, SPEC);

    expect(pagination).toMatchObject({ page: 2, limit: 10, take: 10, skip: 10 });
  });

  it('lets a malformed filter surface as a QueryParamError', () => {
    expect(() => buildListQuery({ status: 'NOPE' }, SPEC)).toThrow(QueryParamError);
    expect(() => buildListQuery({ startDate: 'nonsense' }, SPEC)).toThrow(
      QueryParamError,
    );
  });
});

describe('withScope', () => {
  it('returns the where untouched when there is no scope', () => {
    expect(withScope({ status: 'DRAFT' }, null)).toEqual({ status: 'DRAFT' });
  });

  it('wraps rather than spreads', () => {
    // `{ ...where, clientId }` looks equivalent and is not: when the where has
    // already set clientId, key order decides which one survives.
    expect(withScope({ clientId: OTHER_UUID }, { clientId: UUID })).toEqual({
      AND: [{ clientId: OTHER_UUID }, { clientId: UUID }],
    });
  });

  it('cannot be widened by a filter that built its own AND', () => {
    const scoped = withScope({ AND: [{ a: 1 }, { b: 2 }] }, { clientId: UUID });

    expect(scoped.AND).toHaveLength(2);
    expect(scoped.AND[1]).toEqual({ clientId: UUID });
  });

  it('handles an empty where', () => {
    expect(withScope({}, { clientId: UUID })).toEqual({
      AND: [{}, { clientId: UUID }],
    });
  });
});
