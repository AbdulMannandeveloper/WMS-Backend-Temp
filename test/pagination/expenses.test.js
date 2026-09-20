/**
 * Server-side paging and filtering on the expense list.
 *
 * Two things here are not about paging at all. The first is the bare-array
 * contract: finalizePayroll reads the same repository function to decide
 * whether this month already has a salaries expense, and it reads `.length`
 * and `[0]` off the result. Hand it an envelope and it sees nothing, writes a
 * second salaries expense, and doubles the month in profit and loss.
 *
 * The second is the summary. The grand total and the per-category cards were
 * computed in the browser from the whole array; paginating without moving them
 * to the server would have turned them into totals of whatever was on screen,
 * which is the kind of wrong that looks plausible.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeExpense,
  makeExpenseCategory,
  seedSeries,
  utcDate,
} from '../factories/index.js';
import expenseRepository from '../../repositories/expense.repository.js';

const ids = (body) => body.data.map((row) => row.id);

let admin;
let category;

beforeEach(async () => {
  admin = await makeAdmin();
  category = await makeExpenseCategory({ categoryName: 'Fuel' });
});

describe('the envelope', () => {
  it('answers { data, pagination } with the defaults applied', async () => {
    await seedSeries(3, (i, o) => makeExpense(category.id, { date: o.date }));

    const res = await as(admin).get('/api/expenses');

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
});

describe('page boundaries', () => {
  beforeEach(async () => {
    await seedSeries(7, (i, o) =>
      makeExpense(category.id, { date: o.date, amount: `${10 + i}.00` }),
    );
  });

  it('walks every row exactly once across pages', async () => {
    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await as(admin).get(`/api/expenses?page=${page}&limit=3`);
      seen.push(...ids(res.body));
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('is newest first by default', async () => {
    const res = await as(admin).get('/api/expenses?limit=7');

    // seedSeries walks the date forward, so the last one seeded is the newest.
    expect(Number(res.body.data[0].amount)).toBe(16);
    expect(Number(res.body.data[6].amount)).toBe(10);
  });
});

describe('filters', () => {
  let other;

  beforeEach(async () => {
    other = await makeExpenseCategory({ categoryName: 'Stationery' });

    await makeExpense(category.id, {
      description: 'diesel for the van',
      amount: '50.00',
      date: utcDate(2026, 3, 1),
      receiptImageUrl: 'receipts/a.png',
    });
    await makeExpense(category.id, {
      description: 'petrol',
      amount: '150.00',
      date: utcDate(2026, 3, 15),
      receiptImageUrl: null,
    });
    await makeExpense(other.id, {
      description: 'printer paper',
      amount: '25.00',
      date: utcDate(2026, 3, 31),
      receiptImageUrl: null,
    });
  });

  it('narrows by category', async () => {
    const res = await as(admin).get(`/api/expenses?categoryId=${other.id}`);

    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].description).toBe('printer paper');
  });

  it('searches the description and the category name', async () => {
    const byDescription = await as(admin).get('/api/expenses?search=diesel');
    expect(byDescription.body.data).toHaveLength(1);

    const byCategory = await as(admin).get('/api/expenses?search=stationery');
    expect(byCategory.body.data).toHaveLength(1);
    expect(byCategory.body.data[0].description).toBe('printer paper');
  });

  it('narrows by an amount range, comparing numerically', async () => {
    const res = await as(admin).get('/api/expenses?amountMin=30&amountMax=100');

    expect(res.body.pagination.total).toBe(1);
    expect(Number(res.body.data[0].amount)).toBe(50);

    // 9 is not greater than 150 despite sorting after it as a string.
    const wide = await as(admin).get('/api/expenses?amountMin=9');
    expect(wide.body.pagination.total).toBe(3);
  });

  it('includes rows sitting exactly on both date bounds', async () => {
    const res = await as(admin).get(
      '/api/expenses?startDate=2026-03-01&endDate=2026-03-31',
    );
    expect(res.body.pagination.total).toBe(3);

    const narrower = await as(admin).get(
      '/api/expenses?startDate=2026-03-02&endDate=2026-03-30',
    );
    expect(narrower.body.pagination.total).toBe(1);
  });

  it('narrows by whether a receipt was kept', async () => {
    const withReceipt = await as(admin).get('/api/expenses?hasReceipt=true');
    expect(withReceipt.body.pagination.total).toBe(1);

    const without = await as(admin).get('/api/expenses?hasReceipt=false');
    expect(without.body.pagination.total).toBe(2);
  });

  it('counts what the filter matched, not what the table holds', async () => {
    const res = await as(admin).get(
      `/api/expenses?categoryId=${other.id}&limit=2`,
    );

    expect(res.body.pagination.total).toBe(1);
    expect(res.body.pagination.totalPages).toBe(1);
  });

  it('combines filters rather than letting one overwrite another', async () => {
    // A search and a category filter both narrow; applied together they must
    // intersect, not replace each other.
    const res = await as(admin).get(
      `/api/expenses?categoryId=${category.id}&search=petrol`,
    );

    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].description).toBe('petrol');
  });
});

describe('sorting', () => {
  beforeEach(async () => {
    await makeExpense(category.id, { amount: '30.00', date: utcDate(2026, 5, 1) });
    await makeExpense(category.id, { amount: '10.00', date: utcDate(2026, 5, 2) });
    await makeExpense(category.id, { amount: '20.00', date: utcDate(2026, 5, 3) });
  });

  it('sorts by amount', async () => {
    const res = await as(admin).get('/api/expenses?sortBy=amount&sortOrder=asc');

    expect(res.body.data.map((r) => Number(r.amount))).toEqual([10, 20, 30]);
  });

  it('refuses a column that is not on the list', async () => {
    const res = await as(admin).get('/api/expenses?sortBy=receiptImageUrl');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sortBy must be one of/);
  });
});

describe('malformed parameters', () => {
  it('answer 400, and never leak the query builder', async () => {
    const cases = [
      '/api/expenses?startDate=notadate',
      '/api/expenses?categoryId=not-a-uuid',
      '/api/expenses?amountMin=abc',
      '/api/expenses?amountMin=99&amountMax=1',
      '/api/expenses?hasReceipt=maybe',
    ];

    for (const url of cases) {
      const res = await as(admin).get(url);
      expect(res.status, url).toBe(400);
      expect(JSON.stringify(res.body), url).not.toMatch(/prisma|P20\d\d/i);
    }
  });
});

describe('the summary', () => {
  beforeEach(async () => {
    const other = await makeExpenseCategory({ categoryName: 'Stationery' });
    await makeExpense(category.id, { amount: '50.00', date: utcDate(2026, 6, 1) });
    await makeExpense(category.id, { amount: '150.00', date: utcDate(2026, 6, 2) });
    await makeExpense(other.id, { amount: '25.00', date: utcDate(2026, 6, 3) });
  });

  it('totals the whole filtered set, not the page', async () => {
    const res = await as(admin).get('/api/expenses/summary?limit=1');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(Number(res.body.totalAmount)).toBe(225);
  });

  it('breaks down by category, heaviest first', async () => {
    const res = await as(admin).get('/api/expenses/summary');

    expect(res.body.byCategory).toHaveLength(2);
    expect(res.body.byCategory[0].categoryName).toBe('Fuel');
    expect(Number(res.body.byCategory[0].total)).toBe(200);
    expect(res.body.byCategory[0].count).toBe(2);
  });

  it('agrees with the list it sits above', async () => {
    const list = await as(admin).get(
      `/api/expenses?categoryId=${category.id}&limit=1`,
    );
    const summary = await as(admin).get(
      `/api/expenses/summary?categoryId=${category.id}`,
    );

    expect(summary.body.total).toBe(list.body.pagination.total);
    const summed = summary.body.byCategory.reduce(
      (acc, r) => acc + Number(r.total),
      0,
    );
    expect(summed).toBe(Number(summary.body.totalAmount));
  });

  it('ignores paging and sorting entirely', async () => {
    const plain = await as(admin).get('/api/expenses/summary');
    const noisy = await as(admin).get(
      '/api/expenses/summary?page=3&limit=1&sortBy=amount&sortOrder=asc',
    );

    expect(noisy.body).toEqual(plain.body);
  });

  it('resolves as itself rather than as an expense with that id', async () => {
    const res = await as(admin).get('/api/expenses/summary');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });
});

describe('the internal contract finalizePayroll depends on', () => {
  it('returns a bare array when called without pagination', async () => {
    await makeExpense(category.id, { amount: '10.00', date: utcDate(2026, 7, 1) });
    await makeExpense(category.id, { amount: '20.00', date: utcDate(2026, 7, 2) });

    const rows = await expenseRepository.getAllExpenses({
      categoryId: category.id,
    });

    // Not { items, total }: finalizePayroll reads .length and [0] off this.
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBeTruthy();
  });

  it('finds an existing salaries expense for the month, so payroll does not double it', async () => {
    // The shape of the query finalizePayroll runs: a category plus a month
    // range, expecting the row it wrote last time to come back.
    const salaries = await makeExpenseCategory({
      categoryName: 'Salaries',
      isSystemGenerated: true,
    });
    await prisma.expense.create({
      data: {
        categoryId: salaries.id,
        amount: '1000.00',
        description: 'Finalized payroll',
        date: utcDate(2026, 8, 1),
      },
    });

    const found = await expenseRepository.getAllExpenses({
      categoryId: salaries.id,
      date: { gte: utcDate(2026, 8, 1), lte: utcDate(2026, 8, 31) },
    });

    expect(found).toHaveLength(1);
    expect(Number(found[0].amount)).toBe(1000);
  });
});

describe('authorisation', () => {
  it('is admin only, list and summary alike', async () => {
    const { user: employee } = await makeEmployee();

    expect((await as(employee).get('/api/expenses')).status).toBe(403);
    expect((await as(employee).get('/api/expenses/summary')).status).toBe(403);
  });
});
