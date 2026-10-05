// TESTING-ONLY (whole file) — delete it with the rest; see TESTING_RELAXATIONS.md.

/**
 * Deleting one employee's finalised pay for a month, in testing mode.
 *
 * Reopening a month removes everyone's pay records at once. This removes one,
 * so a test employee's pay can go without touching anyone else's.
 *
 * What must hold:
 *   - The warning says what goes: the pay record, and its share of the
 *     month's Salaries expense.
 *   - The delete removes that record only, and the Salaries expense drops to
 *     what the others were paid — or goes, when no one else's is finalised.
 *   - The employee's fines and bonuses for the month can be changed again.
 *   - A month not finalised for them answers 404.
 *   - Outside testing mode it is refused, and the month reopened instead.
 *   - Admin-only, like the rest of payroll.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import { makeAdmin, makeEmployee, makeEmployeeFine, makePayrollRecord } from '../factories/index.js';
import { enableTestingDeletes } from '../helpers/testingMode.js';

const MONTH = '2026-08-01';
const MONTH_DATE = new Date(Date.UTC(2026, 7, 1));

/** Two employees finalised for the month, and the Salaries expense it posted. */
const arrange = async () => {
  const admin = await makeAdmin();
  const { user: tester } = await makeEmployee();
  const { user: colleague } = await makeEmployee();
  await makePayrollRecord(tester.id, { netPay: '500.00', monthYear: MONTH_DATE });
  await makePayrollRecord(colleague.id, { netPay: '2000.00', monthYear: MONTH_DATE });
  const category = await prisma.expenseCategory.create({
    data: { categoryName: 'Salaries', isSystemGenerated: true },
  });
  const salaries = await prisma.expense.create({
    data: {
      categoryId: category.id,
      amount: '2500.00',
      description: 'Finalized payroll for August 2026 (2 employees)',
      date: MONTH_DATE,
    },
  });
  return { admin, tester, colleague, salaries };
};

const url = (userId) => `/api/payroll/finalize/${MONTH}/employees/${userId}`;

describe('outside testing mode', () => {
  it('is refused, and nothing changes', async () => {
    const { admin, tester } = await arrange();

    const res = await as(admin).delete(url(tester.id));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Reopen the month/);
    expect(await prisma.payrollRecord.count({ where: { userId: tester.id } })).toBe(1);
  });
});

describe("deleting one employee's finalised pay", () => {
  beforeEach(() => enableTestingDeletes());

  it('warns what goes first', async () => {
    const { admin, tester } = await arrange();

    const res = await as(admin).get(`${url(tester.id)}/dependents`);

    expect(res.status).toBe(200);
    expect(res.body.canDelete).toBe(true);
    expect(res.body.removedWith).toEqual([
      expect.objectContaining({ key: 'payrollRecord', count: 1 }),
      expect.objectContaining({ key: 'salariesExpense', count: 1, note: expect.stringMatching(/£2500\.00 to £2000\.00/) }),
    ]);
  });

  it("removes only theirs, and takes it out of the Salaries expense", async () => {
    const { admin, tester, colleague, salaries } = await arrange();

    const res = await as(admin).delete(url(tester.id));

    expect(res.status).toBe(200);
    expect(await prisma.payrollRecord.count({ where: { userId: tester.id } })).toBe(0);
    expect(await prisma.payrollRecord.count({ where: { userId: colleague.id } })).toBe(1);
    const after = await prisma.expense.findUnique({ where: { id: salaries.id } });
    expect(Number(after.amount)).toBe(2000);
    expect(after.description).toMatch(/\(1 employees\)/);
    const entry = await prisma.auditLog.findFirst({ where: { action: 'DELETE_PAYROLL_RECORD' } });
    expect(JSON.parse(entry.details)).toMatchObject({ userId: tester.id, netPay: 500, testingMode: true });
  });

  it('removes the Salaries expense with the last one', async () => {
    const { admin, tester, colleague, salaries } = await arrange();

    await as(admin).delete(url(colleague.id));
    await as(admin).delete(url(tester.id));

    expect(await prisma.payrollRecord.count({ where: { monthYear: MONTH_DATE } })).toBe(0);
    expect(await prisma.expense.count({ where: { id: salaries.id } })).toBe(0);
  });

  it('lets their fines for the month be changed again', async () => {
    const { admin, tester } = await arrange();
    const fine = await makeEmployeeFine(tester.id, { date: new Date(Date.UTC(2026, 7, 10)) });
    const change = () => as(admin).put(`/api/payroll/fines/${fine.id}`).send({ amount: 7 });
    expect((await change()).status).toBe(409);

    await as(admin).delete(url(tester.id));

    expect((await change()).status).toBe(200);
  });

  it('answers 404 for a month not finalised for them', async () => {
    const { admin } = await arrange();
    const { user: unpaid } = await makeEmployee();

    expect((await as(admin).get(`${url(unpaid.id)}/dependents`)).status).toBe(404);
    expect((await as(admin).delete(url(unpaid.id))).status).toBe(404);
    expect((await as(admin).delete(url('not-a-uuid'))).status).toBe(404);
  });

  it('is admin-only', async () => {
    const { tester, colleague } = await arrange();

    expect((await as(colleague).delete(url(tester.id))).status).toBe(403);
    expect(await prisma.payrollRecord.count({ where: { userId: tester.id } })).toBe(1);
  });
});
