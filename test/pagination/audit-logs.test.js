/**
 * Server-side paging and filtering on the audit list.
 *
 * The first endpoint converted, so this file carries the contract the rest are
 * held to: pages that neither repeat nor skip a row, a total that counts what
 * the filter matched rather than what the table holds, a sort key that cannot
 * be pointed at an arbitrary column, and a summary describing the same rows the
 * list is paging.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeAuditLog,
  seedSeries,
} from '../factories/index.js';

const ids = (body) => body.data.map((row) => row.id);

let admin;

beforeEach(async () => {
  admin = await makeAdmin();
});

describe('the envelope', () => {
  it('answers { data, pagination } with the defaults applied', async () => {
    await seedSeries(
      3,
      (i, o) => makeAuditLog(admin.id, { timestamp: o.timestamp }),
      { field: 'timestamp', start: new Date('2026-01-01T09:00:00Z') },
    );

    const res = await as(admin).get('/api/audit-logs');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination).toEqual({
      page: 1,
      limit: 50,
      total: 3,
      totalPages: 1,
      hasMore: false,
    });
  });

  it('never returns a password hash with the person who acted', async () => {
    await makeAuditLog(admin.id);

    const res = await as(admin).get('/api/audit-logs');

    expect(res.body.data[0].user).toBeTruthy();
    expect(res.body.data[0].user.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });
});

describe('page boundaries', () => {
  beforeEach(async () => {
    await seedSeries(
      7,
      (i, o) =>
        makeAuditLog(admin.id, {
          timestamp: o.timestamp,
          action: `ACTION_${String(i).padStart(2, '0')}`,
        }),
      { field: 'timestamp', start: new Date('2026-01-01T09:00:00Z') },
    );
  });

  it('walks every row exactly once across pages', async () => {
    const p1 = await as(admin).get('/api/audit-logs?page=1&limit=3');
    const p2 = await as(admin).get('/api/audit-logs?page=2&limit=3');
    const p3 = await as(admin).get('/api/audit-logs?page=3&limit=3');

    expect(ids(p1.body)).toHaveLength(3);
    expect(ids(p2.body)).toHaveLength(3);
    expect(ids(p3.body)).toHaveLength(1);

    // No row on two pages, and none on no page at all.
    const seen = [...ids(p1.body), ...ids(p2.body), ...ids(p3.body)];
    expect(new Set(seen).size).toBe(7);

    expect(p1.body.pagination.hasMore).toBe(true);
    expect(p2.body.pagination.hasMore).toBe(true);
    expect(p3.body.pagination.hasMore).toBe(false);
    expect(p3.body.pagination.totalPages).toBe(3);
  });

  it('is newest first by default', async () => {
    const res = await as(admin).get('/api/audit-logs?limit=7');

    expect(res.body.data[0].action).toBe('ACTION_06');
    expect(res.body.data[6].action).toBe('ACTION_00');
  });

  it('answers an empty page past the end without lying about the total', async () => {
    const res = await as(admin).get('/api/audit-logs?page=99&limit=3');

    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(7);
    expect(res.body.pagination.hasMore).toBe(false);
  });

  it('clamps a limit past the maximum and a nonsense page', async () => {
    const big = await as(admin).get('/api/audit-logs?limit=9999');
    expect(big.body.pagination.limit).toBe(200);

    const junk = await as(admin).get('/api/audit-logs?page=abc&limit=xyz');
    expect(junk.body.pagination.page).toBe(1);
    expect(junk.body.pagination.limit).toBe(50);
  });
});

describe('a sort key that repeats', () => {
  it('still pages deterministically', async () => {
    // Six rows sharing one timestamp. Without the id tiebreaker Postgres is
    // free to order these differently per query, and a row can land on two
    // pages while another lands on none.
    const sameMoment = new Date('2026-02-02T12:00:00Z');
    for (let i = 0; i < 6; i += 1) {
      await makeAuditLog(admin.id, {
        timestamp: sameMoment,
        action: `SAME_${i}`,
      });
    }

    const readAll = async () => {
      const out = [];
      for (const page of [1, 2, 3]) {
        const res = await as(admin).get(`/api/audit-logs?page=${page}&limit=2`);
        out.push(...ids(res.body));
      }
      return out;
    };

    const first = await readAll();
    const second = await readAll();

    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(6);
  });
});

describe('filters', () => {
  beforeEach(async () => {
    const other = await makeAdmin();
    await makeAuditLog(admin.id, {
      action: 'DELETE_PRODUCT',
      details: 'removed the blue widget',
      timestamp: new Date('2026-03-01T10:00:00Z'),
    });
    await makeAuditLog(other.id, {
      action: 'EDIT_PRODUCT',
      details: 'renamed the red widget',
      timestamp: new Date('2026-03-10T10:00:00Z'),
    });
    await makeAuditLog(admin.id, {
      action: 'ADJUST_STOCK',
      details: 'counted the shelf',
      timestamp: new Date('2026-03-20T10:00:00Z'),
    });
  });

  it('narrows by action', async () => {
    const res = await as(admin).get('/api/audit-logs?action=EDIT_PRODUCT');

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].action).toBe('EDIT_PRODUCT');
  });

  it('narrows by the person who acted', async () => {
    const res = await as(admin).get(`/api/audit-logs?userId=${admin.id}`);

    expect(res.body.pagination.total).toBe(2);
    for (const row of res.body.data) expect(row.userId).toBe(admin.id);
  });

  it('searches the action and the details', async () => {
    const byAction = await as(admin).get('/api/audit-logs?search=ADJUST');
    expect(byAction.body.data).toHaveLength(1);

    const byDetail = await as(admin).get('/api/audit-logs?search=blue widget');
    expect(byDetail.body.data).toHaveLength(1);
    expect(byDetail.body.data[0].action).toBe('DELETE_PRODUCT');
  });

  it('includes rows sitting exactly on both date bounds', async () => {
    // The row at 10:00 on the end date is inside the range: a timestamp column
    // has its end bound carried to the last instant of that day.
    const res = await as(admin).get(
      '/api/audit-logs?startDate=2026-03-01&endDate=2026-03-20',
    );
    expect(res.body.pagination.total).toBe(3);

    const narrower = await as(admin).get(
      '/api/audit-logs?startDate=2026-03-02&endDate=2026-03-19',
    );
    expect(narrower.body.pagination.total).toBe(1);
  });

  it('counts what the filter matched, not what the table holds', async () => {
    // The regression test for a count() missing its where: three rows exist,
    // one matches, and the total under a two-row page must say one.
    const res = await as(admin).get(
      '/api/audit-logs?action=ADJUST_STOCK&limit=2',
    );

    expect(res.body.pagination.total).toBe(1);
    expect(res.body.pagination.totalPages).toBe(1);
  });

  it('applies the filter independently of the paging', async () => {
    const whole = await as(admin).get(
      `/api/audit-logs?userId=${admin.id}&limit=100`,
    );

    const paged = [];
    for (const page of [1, 2]) {
      const res = await as(admin).get(
        `/api/audit-logs?userId=${admin.id}&page=${page}&limit=1`,
      );
      paged.push(...ids(res.body));
    }

    expect(paged).toEqual(ids(whole.body));
  });
});

describe('sorting', () => {
  beforeEach(async () => {
    await seedSeries(
      3,
      (i, o) =>
        makeAuditLog(admin.id, { timestamp: o.timestamp, action: `ACT_${i}` }),
      { field: 'timestamp', start: new Date('2026-04-01T09:00:00Z') },
    );
  });

  it('reverses on sortOrder', async () => {
    const desc = await as(admin).get('/api/audit-logs?limit=10');
    const asc = await as(admin).get('/api/audit-logs?sortOrder=asc&limit=10');

    expect(ids(asc.body)).toEqual([...ids(desc.body)].reverse());
  });

  it('sorts by an allowed key', async () => {
    const res = await as(admin).get(
      '/api/audit-logs?sortBy=action&sortOrder=asc',
    );

    expect(res.body.data.map((r) => r.action)).toEqual([
      'ACT_0',
      'ACT_1',
      'ACT_2',
    ]);
  });

  it('refuses a column that is not on the list, rather than ignoring it', async () => {
    const res = await as(admin).get('/api/audit-logs?sortBy=passwordHash');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sortBy must be one of/);
  });

  it('refuses a raw relation path', async () => {
    const res = await as(admin).get('/api/audit-logs?sortBy=user.passwordHash');

    expect(res.status).toBe(400);
  });
});

describe('malformed parameters', () => {
  it('answer 400, and never leak the query builder', async () => {
    const cases = [
      '/api/audit-logs?startDate=notadate',
      '/api/audit-logs?userId=not-a-uuid',
      '/api/audit-logs?sortOrder=sideways',
      '/api/audit-logs?startDate=2026-05-01&endDate=2026-04-01',
    ];

    for (const url of cases) {
      const res = await as(admin).get(url);
      expect(res.status, url).toBe(400);
      // Prisma names the model, the column and the invocation in its own
      // errors; none of that belongs in a response to a bad query string.
      expect(JSON.stringify(res.body), url).not.toMatch(/prisma|P20\d\d/i);
    }
  });
});

describe('the summary', () => {
  beforeEach(async () => {
    await makeAuditLog(admin.id, { action: 'EDIT_PRODUCT' });
    await makeAuditLog(admin.id, { action: 'EDIT_PRODUCT' });
    await makeAuditLog(admin.id, { action: 'ADJUST_STOCK' });
  });

  it('counts the whole filtered set, not the page', async () => {
    const res = await as(admin).get('/api/audit-logs/summary?limit=1');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.byAction).toContainEqual({
      action: 'EDIT_PRODUCT',
      count: 2,
    });
    expect(res.body.byAction).toContainEqual({
      action: 'ADJUST_STOCK',
      count: 1,
    });
  });

  it('agrees with the list it sits above', async () => {
    const list = await as(admin).get(
      '/api/audit-logs?action=EDIT_PRODUCT&limit=1',
    );
    const summary = await as(admin).get(
      '/api/audit-logs/summary?action=EDIT_PRODUCT',
    );

    expect(summary.body.total).toBe(list.body.pagination.total);
    const summed = summary.body.byAction.reduce((acc, r) => acc + r.count, 0);
    expect(summed).toBe(summary.body.total);
  });

  it('ignores paging and sorting entirely', async () => {
    const plain = await as(admin).get(
      '/api/audit-logs/summary?action=EDIT_PRODUCT',
    );
    const noisy = await as(admin).get(
      '/api/audit-logs/summary?action=EDIT_PRODUCT&page=3&limit=1&sortBy=action&sortOrder=asc',
    );

    expect(noisy.body).toEqual(plain.body);
  });

  it('resolves as itself, not as a row with the id "summary"', async () => {
    const res = await as(admin).get('/api/audit-logs/summary');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });
});

describe('authorisation', () => {
  it('is admin only, list and summary alike', async () => {
    const { user: employee } = await makeEmployee();

    expect((await as(employee).get('/api/audit-logs')).status).toBe(403);
    expect((await as(employee).get('/api/audit-logs/summary')).status).toBe(403);
  });
});
