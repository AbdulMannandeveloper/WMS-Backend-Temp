/**
 * Correcting payroll inputs: fines, bonuses and fine rules.
 *
 * What must hold:
 *   - A fine or bonus can be edited (reason, amount, date) or deleted while its
 *     month is open for that employee.
 *   - Once that month's payroll is finalised for them, both are refused — and
 *     so is cancelling or reinstating a fine, or adding a new one — and a date
 *     change cannot move one into a finalised month either.
 *   - Reopening a finalised month removes its pay records and Salaries
 *     expense, after which it can be corrected and finalised again.
 *   - Removing the fine rule in force puts the previous one back in force.
 *   - The summary says which employees' months are finalised, and for how much.
 *   - All of it is admin-only, like the rest of payroll.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeEmployeeFine,
  makeEmployeeBonus,
  makeFineRule,
  makePayrollRecord,
} from '../factories/index.js';

/** An admin and an employee whose fine and bonus sit in the factories' month. */
const scenario = async () => {
  const admin = await makeAdmin();
  const { user } = await makeEmployee();
  const fine = await makeEmployeeFine(user.id);
  const bonus = await makeEmployeeBonus(user.id);
  return { admin, user, fine, bonus };
};

/** Finalises the factories' month for this employee. */
const finalise = (user, fine) =>
  makePayrollRecord(user.id, {
    monthYear: new Date(Date.UTC(fine.date.getUTCFullYear(), fine.date.getUTCMonth(), 1)),
  });

describe('fines', () => {
  it('can be corrected while the month is open', async () => {
    const { admin, fine } = await scenario();

    const res = await as(admin)
      .put(`/api/payroll/fines/${fine.id}`)
      .send({ reason: ' Late — 20 min ', amount: 12.5 });

    expect(res.status).toBe(200);
    const after = await prisma.employeeFine.findUnique({ where: { id: fine.id } });
    expect(after.reason).toBe('Late — 20 min');
    expect(Number(after.amount)).toBe(12.5);
  });

  it('can be deleted while the month is open', async () => {
    const { admin, fine } = await scenario();

    expect((await as(admin).delete(`/api/payroll/fines/${fine.id}`)).status).toBe(200);
    expect(await prisma.employeeFine.count({ where: { id: fine.id } })).toBe(0);
  });

  it('are fixed once the month is finalised for that employee', async () => {
    const { admin, user, fine } = await scenario();
    await finalise(user, fine);

    const edit = await as(admin).put(`/api/payroll/fines/${fine.id}`).send({ amount: 1 });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toMatch(/finalised/i);
    expect((await as(admin).delete(`/api/payroll/fines/${fine.id}`)).status).toBe(409);
    expect(await prisma.employeeFine.count({ where: { id: fine.id } })).toBe(1);
  });

  it('cannot be cancelled or reinstated once the month is finalised', async () => {
    const { admin, user, fine } = await scenario();
    await finalise(user, fine);

    const res = await as(admin).patch(`/api/payroll/fines/${fine.id}/cancel`);

    expect(res.status).toBe(409);
    expect((await prisma.employeeFine.findUnique({ where: { id: fine.id } })).cancelled).toBe(false);
  });

  it('can still be cancelled while the month is open', async () => {
    const { admin, fine } = await scenario();

    expect((await as(admin).patch(`/api/payroll/fines/${fine.id}/cancel`)).status).toBe(200);
  });

  it('cannot be added to a finalised month, but can to an open one', async () => {
    const { admin, user, fine } = await scenario();
    await finalise(user, fine);
    const add = (date) =>
      as(admin).post('/api/payroll/fines').send({ userId: user.id, amount: 5, reason: 'Late', date });

    const refused = await add(fine.date.toISOString().slice(0, 10));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Reopen the month/);
    expect((await add('2030-01-10')).status).toBe(201);
  });

  it('cannot be moved into a finalised month', async () => {
    const { admin, user, fine } = await scenario();
    const later = await makeEmployeeFine(user.id, { date: new Date(Date.UTC(2030, 0, 10)) });
    await finalise(user, fine);

    const res = await as(admin)
      .put(`/api/payroll/fines/${later.id}`)
      .send({ date: fine.date.toISOString().slice(0, 10) });

    expect(res.status).toBe(409);
  });

  it('refuses a zero amount and an empty reason', async () => {
    const { admin, fine } = await scenario();

    expect((await as(admin).put(`/api/payroll/fines/${fine.id}`).send({ amount: 0 })).status).toBe(400);
    expect((await as(admin).put(`/api/payroll/fines/${fine.id}`).send({ reason: ' ' })).status).toBe(400);
  });
});

describe('bonuses', () => {
  it('can be corrected and deleted while the month is open', async () => {
    const { admin, bonus } = await scenario();

    const res = await as(admin).put(`/api/payroll/bonuses/${bonus.id}`).send({ amount: 75 });
    expect(res.status).toBe(200);
    expect(Number(res.body.amount)).toBe(75);

    expect((await as(admin).delete(`/api/payroll/bonuses/${bonus.id}`)).status).toBe(200);
    expect(await prisma.employeeBonus.count({ where: { id: bonus.id } })).toBe(0);
  });

  it('are fixed once the month is finalised for that employee', async () => {
    const { admin, user, fine, bonus } = await scenario();
    await finalise(user, fine);

    expect((await as(admin).put(`/api/payroll/bonuses/${bonus.id}`).send({ amount: 1 })).status).toBe(
      409,
    );
    expect((await as(admin).delete(`/api/payroll/bonuses/${bonus.id}`)).status).toBe(409);
    const add = await as(admin)
      .post('/api/payroll/bonuses')
      .send({ userId: user.id, amount: 5, reason: 'Extra', date: bonus.date.toISOString().slice(0, 10) });
    expect(add.status).toBe(409);
  });
});

describe('reopening a finalised month', () => {
  /** Finalises the factories' month through the app, which also posts Salaries. */
  const finaliseThroughApp = async (admin, fine) => {
    const month = `${fine.date.toISOString().slice(0, 7)}-01`;
    expect((await as(admin).post('/api/payroll/finalize').send({ monthYear: month })).status).toBe(200);
    return month;
  };

  const salariesExpenses = () =>
    prisma.expense.count({ where: { category: { categoryName: 'Salaries' } } });

  it('warns that the pay records and the Salaries expense go', async () => {
    const { admin, fine } = await scenario();
    const month = await finaliseThroughApp(admin, fine);

    const res = await as(admin).get(`/api/payroll/finalize/${month}/dependents`);

    expect(res.status).toBe(200);
    expect(res.body.canDelete).toBe(true);
    expect(res.body.removedWith.map((r) => r.key)).toEqual(['payrollRecords', 'salariesExpense']);
  });

  it('removes them, after which fines and bonuses can be corrected again', async () => {
    const { admin, fine } = await scenario();
    const month = await finaliseThroughApp(admin, fine);
    expect(await salariesExpenses()).toBe(1);

    const res = await as(admin).delete(`/api/payroll/finalize/${month}`);

    expect(res.status).toBe(200);
    expect(await prisma.payrollRecord.count({ where: { monthYear: new Date(month) } })).toBe(0);
    expect(await salariesExpenses()).toBe(0);
    expect((await as(admin).put(`/api/payroll/fines/${fine.id}`).send({ amount: 1 })).status).toBe(200);
  });

  it('can be finalised again afterwards', async () => {
    const { admin, fine } = await scenario();
    const month = await finaliseThroughApp(admin, fine);
    await as(admin).delete(`/api/payroll/finalize/${month}`);

    await finaliseThroughApp(admin, fine);

    expect(await salariesExpenses()).toBe(1);
  });

  it('answers 404 for a month that was never finalised', async () => {
    const admin = await makeAdmin();

    expect((await as(admin).get('/api/payroll/finalize/2031-03-01/dependents')).status).toBe(404);
    expect((await as(admin).delete('/api/payroll/finalize/2031-03-01')).status).toBe(404);
  });
});

describe('fine rules', () => {
  it('removing the one in force puts the previous one back', async () => {
    const admin = await makeAdmin();
    const older = await makeFineRule({ amount: '5.00', createdAt: new Date(Date.UTC(2026, 0, 1)) });
    const newer = await makeFineRule({ amount: '9.00', createdAt: new Date(Date.UTC(2026, 5, 1)) });

    const res = await as(admin).delete(`/api/payroll/rules/${newer.id}`);

    expect(res.status).toBe(200);
    expect(res.body.activeRule.id).toBe(older.id);
    const active = await as(admin).get('/api/payroll/rules/active');
    expect(active.body.id).toBe(older.id);
  });
});

describe('the summary', () => {
  it('says whose month is finalised', async () => {
    const { admin, user, fine } = await scenario();
    await finalise(user, fine);
    const month = fine.date.toISOString().slice(0, 7);

    const res = await as(admin).get('/api/payroll/summary').query({ monthYear: `${month}-01` });

    expect(res.status).toBe(200);
    expect(res.body.find((r) => r.userId === user.id).finalised).toBe(true);
  });

  it('gives what was finalised, so a later change shows', async () => {
    const { admin, user, fine } = await scenario();
    await finalise(user, fine);
    const employee = await prisma.employee.findUnique({ where: { userId: user.id } });
    await as(admin).put(`/api/payroll/employees/${employee.id}/base-salary`).send({ amount: 3000 });
    const month = fine.date.toISOString().slice(0, 7);

    const res = await as(admin).get('/api/payroll/summary').query({ monthYear: `${month}-01` });

    const row = res.body.find((r) => r.userId === user.id);
    expect(row.finalisedNetPay).toBe(2000);
    expect(row.netPay).not.toBe(2000);
  });
});

describe('who may correct payroll', () => {
  it('is admins only', async () => {
    const { user, fine, bonus } = await scenario();
    const rule = await makeFineRule();

    expect((await as(user).put(`/api/payroll/fines/${fine.id}`).send({ amount: 1 })).status).toBe(403);
    expect((await as(user).delete(`/api/payroll/fines/${fine.id}`)).status).toBe(403);
    expect((await as(user).put(`/api/payroll/bonuses/${bonus.id}`).send({ amount: 1 })).status).toBe(
      403,
    );
    expect((await as(user).delete(`/api/payroll/bonuses/${bonus.id}`)).status).toBe(403);
    expect((await as(user).delete(`/api/payroll/rules/${rule.id}`)).status).toBe(403);
    expect((await as(user).get('/api/payroll/finalize/2026-09-01/dependents')).status).toBe(403);
    expect((await as(user).delete('/api/payroll/finalize/2026-09-01')).status).toBe(403);
  });
});
