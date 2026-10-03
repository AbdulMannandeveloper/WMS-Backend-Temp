/**
 * Editing expenses, and renaming and deleting expense categories.
 *
 * What must hold:
 *   - A manual expense can be corrected; a salary expense cannot, because
 *     payroll writes it, and nothing can be moved into Salaries.
 *   - Only the editable fields change.
 *   - A category in use cannot be deleted — the warning says so first — and
 *     the built-in Salaries category is neither renamed nor deleted.
 *   - All of it is admin-only, like the rest of the module.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeExpense,
  makeExpenseCategory,
} from '../factories/index.js';

const salaries = () =>
  prisma.expenseCategory.create({ data: { categoryName: 'Salaries', isSystemGenerated: true } });

describe('editing an expense', () => {
  it('corrects the amount, date, description and category', async () => {
    const admin = await makeAdmin();
    const expense = await makeExpense();
    const other = await makeExpenseCategory();

    const res = await as(admin)
      .put(`/api/expenses/${expense.id}`)
      .send({ amount: 42.5, date: '2026-09-01', description: ' Printer ink ', categoryId: other.id });

    expect(res.status).toBe(200);
    const after = await prisma.expense.findUnique({ where: { id: expense.id } });
    expect(Number(after.amount)).toBe(42.5);
    expect(after.description).toBe('Printer ink');
    expect(after.categoryId).toBe(other.id);
    expect(after.date.toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  it('ignores fields an edit may not change', async () => {
    const admin = await makeAdmin();
    const expense = await makeExpense();

    await as(admin).put(`/api/expenses/${expense.id}`).send({ id: 'other', description: 'x' });

    expect(await prisma.expense.count({ where: { id: expense.id } })).toBe(1);
  });

  it('refuses a zero amount', async () => {
    const admin = await makeAdmin();
    const expense = await makeExpense();

    const res = await as(admin).put(`/api/expenses/${expense.id}`).send({ amount: 0 });

    expect(res.status).toBe(400);
  });

  it('refuses a salary expense, and moving anything into Salaries', async () => {
    const admin = await makeAdmin();
    const category = await salaries();
    const salary = await makeExpense(category.id);
    const manual = await makeExpense();

    expect((await as(admin).put(`/api/expenses/${salary.id}`).send({ amount: 1 })).status).toBe(400);
    expect(
      (await as(admin).put(`/api/expenses/${manual.id}`).send({ categoryId: category.id })).status,
    ).toBe(400);
  });

  it('is admin-only', async () => {
    const { user } = await makeEmployee();
    const expense = await makeExpense();

    expect((await as(user).put(`/api/expenses/${expense.id}`).send({ amount: 5 })).status).toBe(403);
  });
});

describe('expense categories', () => {
  it('can be renamed, but not to a name already taken', async () => {
    const admin = await makeAdmin();
    const category = await makeExpenseCategory();
    const taken = await makeExpenseCategory();

    const res = await as(admin)
      .put(`/api/expenses/categories/${category.id}`)
      .send({ categoryName: 'Marketing' });
    expect(res.status).toBe(200);
    expect(res.body.categoryName).toBe('Marketing');

    const clash = await as(admin)
      .put(`/api/expenses/categories/${category.id}`)
      .send({ categoryName: taken.categoryName });
    expect(clash.status).toBe(400);
  });

  it('cannot be deleted while expenses are filed under it, and the warning says so first', async () => {
    const admin = await makeAdmin();
    const category = await makeExpenseCategory();
    await makeExpense(category.id);

    const warning = await as(admin).get(`/api/expenses/categories/${category.id}/dependents`);
    expect(warning.body.canDelete).toBe(false);
    expect(warning.body.blocking).toEqual([expect.objectContaining({ key: 'expenses', count: 1 })]);

    const res = await as(admin).delete(`/api/expenses/categories/${category.id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HAS_DEPENDENTS');
    expect(await prisma.expenseCategory.count({ where: { id: category.id } })).toBe(1);
  });

  it('can be deleted once empty', async () => {
    const admin = await makeAdmin();
    const category = await makeExpenseCategory();

    expect((await as(admin).delete(`/api/expenses/categories/${category.id}`)).status).toBe(200);
    expect(await prisma.expenseCategory.count({ where: { id: category.id } })).toBe(0);
  });

  it('keeps Salaries: not renamed, not deleted', async () => {
    const admin = await makeAdmin();
    const category = await salaries();

    expect(
      (await as(admin).put(`/api/expenses/categories/${category.id}`).send({ categoryName: 'Pay' }))
        .status,
    ).toBe(400);
    const res = await as(admin).delete(`/api/expenses/categories/${category.id}`);
    expect(res.status).toBe(409);
    expect(res.body.dependents.blocking.map((r) => r.key)).toEqual(['builtIn']);
  });

  it('are admin-only to change', async () => {
    const { user } = await makeEmployee();
    const category = await makeExpenseCategory();

    expect(
      (await as(user).put(`/api/expenses/categories/${category.id}`).send({ categoryName: 'x' }))
        .status,
    ).toBe(403);
    expect((await as(user).get(`/api/expenses/categories/${category.id}/dependents`)).status).toBe(403);
    expect((await as(user).delete(`/api/expenses/categories/${category.id}`)).status).toBe(403);
  });
});
