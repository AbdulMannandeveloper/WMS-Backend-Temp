/**
 * The fixture builders themselves.
 *
 * Worth testing directly, because a broken factory fails every suite that uses
 * it with an error about the factory rather than the thing under test — and
 * because two of these were written against enum values that do not exist
 * (INBOUND, MANUAL_ENTRY) and only a real insert caught it.
 *
 * The date assertions matter more than they look: constructing a @db.Date from
 * local time stores the previous day east of UTC, which is how a month-boundary
 * row ends up filed under the wrong month.
 */

import { describe, it, expect } from 'vitest';

import {
  utcDate,
  makeWarehouseScenario,
  makeInvoice,
  makeService,
  makeShipment,
  makeExpenseCategory,
  makeExpense,
  makeHoliday,
  makeAttendanceLog,
  makeAttendanceSummary,
  makePayrollRecord,
  makeFineRule,
  makeEmployeeFine,
  makeEmployeeBonus,
  makeLedgerEntry,
  makeInvoiceLineItem,
  makeShipmentServiceMapping,
} from '../factories/index.js';

describe('every builder inserts a real row', () => {
  it('operations fixtures', async () => {
    const { employeeUser } = await makeWarehouseScenario();

    const category = await makeExpenseCategory();
    expect(await makeExpense(category.id)).toHaveProperty('id');
    expect(await makeHoliday()).toHaveProperty('id');
    expect(await makeAttendanceLog(employeeUser.id)).toHaveProperty('id');
    expect(await makeAttendanceSummary(employeeUser.id)).toHaveProperty('id');
    expect(await makePayrollRecord(employeeUser.id)).toHaveProperty('id');
    expect(await makeFineRule()).toHaveProperty('id');
    expect(await makeEmployeeFine(employeeUser.id)).toHaveProperty('id');
    expect(await makeEmployeeBonus(employeeUser.id)).toHaveProperty('id');
  });

  it('stock and billing fixtures', async () => {
    const { admin, client, employee, product } = await makeWarehouseScenario();

    expect(await makeLedgerEntry(product.id, admin.id)).toHaveProperty('id');

    const invoice = await makeInvoice(client.id);
    expect(await makeInvoiceLineItem(invoice.id)).toHaveProperty('id');

    const service = await makeService();
    const shipment = await makeShipment(employee.id, client.id);
    expect(
      await makeShipmentServiceMapping(shipment.id, service.id)
    ).toHaveProperty('id');
  });

  it('makes an expense category on its own when not given one', async () => {
    const expense = await makeExpense();
    expect(expense.categoryId).toBeTruthy();
  });
});

describe('date-only fields land on the intended day', () => {
  it('utcDate builds midnight UTC, not midnight local', async () => {
    // Ahead of UTC, a local-time Date for the 1st is the previous month's last
    // day once Postgres stores it as a date.
    expect(utcDate(2026, 8, 1).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('survives the round trip through Postgres', async () => {
    const holiday = await makeHoliday();
    expect(holiday.startDate.toISOString().slice(0, 10)).toBe('2026-12-25');
  });

  it('files a payroll record under the month it says', async () => {
    const { employeeUser } = await makeWarehouseScenario();
    const record = await makePayrollRecord(employeeUser.id);

    expect(record.monthYear.toISOString().slice(0, 10)).toBe('2026-08-01');
  });
});
