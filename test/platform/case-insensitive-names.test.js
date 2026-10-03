/**
 * Category and shift names are one name whatever the case.
 *
 * Expense categories, bulk-shipment categories and shifts each refused an
 * exact duplicate and let `Fuel` sit beside `fuel`. Shifts mattered most:
 * check-in times every arrival against the shift named "default", found by
 * exact name, so one saved as "Default" was never found and attendance stopped
 * being recorded without a word (login swallows the error).
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import { makeAdmin, makeEmployee, makeShift } from '../factories/index.js';

describe('expense categories', () => {
  it('refuses a name that differs only in case', async () => {
    const admin = await makeAdmin();
    await as(admin).post('/api/expenses/categories').send({ categoryName: 'Fuel' });

    const res = await as(admin).post('/api/expenses/categories').send({ categoryName: ' fuel ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('refuses a rename onto another category in another case', async () => {
    const admin = await makeAdmin();
    await as(admin).post('/api/expenses/categories').send({ categoryName: 'Rent' });
    const other = await as(admin).post('/api/expenses/categories').send({ categoryName: 'Rates' });

    const res = await as(admin).put(`/api/expenses/categories/${other.body.id}`).send({ categoryName: 'RENT' });

    expect(res.status).toBe(400);
  });

  it('lets a category change the case of its own name', async () => {
    const admin = await makeAdmin();
    const created = await as(admin).post('/api/expenses/categories').send({ categoryName: 'office supplies' });

    const res = await as(admin)
      .put(`/api/expenses/categories/${created.body.id}`)
      .send({ categoryName: 'Office Supplies' });

    expect(res.status).toBe(200);
    expect(res.body.categoryName).toBe('Office Supplies');
  });

  it('refuses a hand-made "salaries" beside the payroll one', async () => {
    // Listing the categories makes sure payroll's Salaries exists.
    const admin = await makeAdmin();
    await as(admin).get('/api/expenses/categories');

    const res = await as(admin).post('/api/expenses/categories').send({ categoryName: 'salaries' });

    expect(res.status).toBe(400);
    const system = await prisma.expenseCategory.findUnique({ where: { categoryName: 'Salaries' } });
    expect(system.isSystemGenerated).toBe(true);
  });
});

describe('bulk-shipment categories', () => {
  it('refuses a name that differs only in case', async () => {
    const admin = await makeAdmin();
    await as(admin).post('/api/fba-shipments/categories').send({ name: 'Pallet' });

    const res = await as(admin).post('/api/fba-shipments/categories').send({ name: 'PALLET' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('lets a category change the case of its own name', async () => {
    const admin = await makeAdmin();
    const created = await as(admin).post('/api/fba-shipments/categories').send({ name: 'half pallet' });

    const res = await as(admin)
      .put(`/api/fba-shipments/categories/${created.body.id}`)
      .send({ name: 'Half Pallet' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Half Pallet');
  });
});

describe('shifts', () => {
  const shiftBody = (name) => ({
    name,
    startTime: '1970-01-01T08:00:00.000Z',
    endTime: '1970-01-01T17:00:00.000Z',
  });

  it('refuses a name that differs only in case or spacing', async () => {
    const admin = await makeAdmin();
    await makeShift({ name: 'Morning' });

    const res = await as(admin).post('/api/shifts').send(shiftBody(' morning '));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('times check-in against a default shift saved as "Default"', async () => {
    await makeShift({ name: 'Default' });
    const { user } = await makeEmployee();

    const res = await as(user).post('/api/attendance').send({
      loginTimestamp: '2026-08-04T08:00:00.000Z',
      date: '2026-08-04T00:00:00.000Z',
    });

    expect(res.status).toBe(201);
    expect(await prisma.employeeAttendanceLog.count({ where: { userId: user.id } })).toBe(1);
  });

  it('lets the default shift be recased, but not renamed', async () => {
    const admin = await makeAdmin();
    const shift = await makeShift();

    const recased = await as(admin).put(`/api/shifts/${shift.id}`).send({ name: 'Default' });
    expect(recased.status).toBe(200);

    const renamed = await as(admin).put(`/api/shifts/${shift.id}`).send({ name: 'day' });
    expect(renamed.status).toBe(400);
  });

  it('protects a default shift saved as "DEFAULT" from deletion', async () => {
    const admin = await makeAdmin();
    const shift = await makeShift({ name: 'DEFAULT' });

    const res = await as(admin).delete(`/api/shifts/${shift.id}`);

    expect(res.status).toBe(409);
    expect(await prisma.shift.count({ where: { id: shift.id } })).toBe(1);
  });

  it('refuses blanking a shift name', async () => {
    const admin = await makeAdmin();
    const shift = await makeShift({ name: 'night' });

    const res = await as(admin).put(`/api/shifts/${shift.id}`).send({ name: '   ' });

    expect(res.status).toBe(400);
  });
});

describe('the database rule', () => {
  it('refuses shifts that differ only in case', async () => {
    await makeShift({ name: 'Evening' });

    await expect(makeShift({ name: 'evening' })).rejects.toThrow(/uq_shifts_name_ci|lower\(name/);
  });

  it('refuses expense categories that differ only in case', async () => {
    await prisma.expenseCategory.create({ data: { categoryName: 'Travel' } });

    await expect(
      prisma.expenseCategory.create({ data: { categoryName: 'TRAVEL' } }),
    ).rejects.toThrow(/uq_expense_categories_name_ci|lower\(category_name/);
  });

  it('refuses bulk-shipment categories that differ only in case', async () => {
    await prisma.fbaCategory.create({ data: { name: 'Box' } });

    await expect(prisma.fbaCategory.create({ data: { name: 'box' } })).rejects.toThrow(
      /uq_fba_categories_name_ci|lower\(name/,
    );
  });
});
