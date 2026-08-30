/**
 * Employee records.
 *
 * An Employee row is the warehouse-side profile hanging off a User; the User
 * carries the login and the role. Both are created together.
 *
 * This whole router was never mounted. routes/employee.routes.js existed,
 * app.js never used it, and /api/employees returned 404 to everyone — while the
 * frontend called it from three places, two of them behind `.catch(() => [])`,
 * which swallowed the 404 and left an empty list. Shipment creation checks
 * `employees.length === 0` before opening its dialog, so nobody could raise a
 * shipment through the UI at all.
 *
 * Mounting it exposed a second problem, which is why the scoping tests below
 * exist: an Employee carries a National Insurance number, date of birth, home
 * address and salary, and GET /:id has always been open to the employee role.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import { makeAdmin, makeEmployee, makeClient } from '../factories/index.js';

describe('employee records', () => {
  it('are listed for an admin only', async () => {
    const admin = await makeAdmin();
    await makeEmployee();

    expect((await as(admin).get('/api/employees')).status).toBe(200);
  });

  it('are not listable by an employee', async () => {
    const { user: employeeUser } = await makeEmployee();
    expect((await as(employeeUser).get('/api/employees')).status).toBe(403);
  });

  it('let an employee read their own record', async () => {
    const { user: employeeUser, employee } = await makeEmployee();
    expect((await as(employeeUser).get(`/api/employees/${employee.id}`)).status).toBe(200);
  });

  it('do NOT let an employee read a colleague', async () => {
    // An Employee row holds an NI number, date of birth, home address and
    // salary. Before scoping, any employee could walk ids and read all of it.
    const { user: employeeUser } = await makeEmployee();
    const { employee: colleague } = await makeEmployee();

    const res = await as(employeeUser).get(`/api/employees/${colleague.id}`);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/nationalInsurance|baseSalary/i);
  });

  it('let an admin read anyone', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();

    expect((await as(admin).get(`/api/employees/${employee.id}`)).status).toBe(200);
  });

  it('do not leak a colleague NI number through the payload either', async () => {
    const { user: employeeUser } = await makeEmployee();
    const { employee: colleague } = await makeEmployee({
      nationalInsuranceNumber: 'QQ123456C',
    });

    const res = await as(employeeUser).get(`/api/employees/${colleague.id}`);

    expect(JSON.stringify(res.body)).not.toContain('QQ123456C');
  });

  it('are closed to clients entirely', async () => {
    const { user: clientUser } = await makeClient();
    const { employee } = await makeEmployee();

    expect((await as(clientUser).get('/api/employees')).status).toBe(403);
    expect((await as(clientUser).get(`/api/employees/${employee.id}`)).status).toBe(403);
  });

  it('refuse anonymous requests', async () => {
    expect((await anon().get('/api/employees')).status).toBe(401);
  });

  it('carry a distinct employee number each', async () => {
    await makeEmployee();
    await makeEmployee();
    await makeEmployee();

    const numbers = (
      await prisma.employee.findMany({ select: { employeeUniqueNumber: true } })
    ).map((e) => e.employeeUniqueNumber);

    expect(numbers.filter(Boolean)).toHaveLength(3);
    expect(new Set(numbers).size).toBe(3);
  });

  it('offer staff a lookup carrying names and nothing else', async () => {
    // Raising a shipment needs a list of operators to choose from. It does not
    // need everyone's salary, and an employee cannot read the full list.
    const { user: employeeUser } = await makeEmployee();
    await makeEmployee({ nationalInsuranceNumber: 'QQ654321B', baseSalary: '31000.00' });

    const res = await as(employeeUser).get('/api/employees/lookup');

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('firstName');
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('QQ654321B');
    expect(serialised).not.toMatch(/baseSalary|nationalInsurance|dateOfBirth|address/i);
  });

  it('route "lookup" to the lookup, not to an id', async () => {
    // Declared after '/:id' it would be parsed as an employee id and 404.
    const admin = await makeAdmin();
    expect((await as(admin).get('/api/employees/lookup')).status).toBe(200);
  });

  it('never expose a password hash', async () => {
    const admin = await makeAdmin();
    await makeEmployee();

    const res = await as(admin).get('/api/employees');

    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });
});
