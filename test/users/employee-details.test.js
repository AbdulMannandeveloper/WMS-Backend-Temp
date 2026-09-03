/**
 * Editing an employment record.
 *
 * The Employee row has always carried jobTitle, nationalInsuranceNumber,
 * dateOfBirth, wageRate and address — and until now there was no update
 * endpoint at all, so none of those columns could ever be filled in. The tab
 * that appeared to manage employees only listed them and created one, and
 * creating became redundant once the Users page started making the profile too.
 *
 * This is also the most sensitive data the system holds about staff, which is
 * why the write is admin-only and the allowlist is asserted rather than assumed.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import { makeAdmin, makeEmployee, makeClient } from '../factories/index.js';

const reload = (id) => prisma.employee.findUnique({ where: { id } });

describe('updating employment details', () => {
  it('sets the fields nothing could previously write', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();

    const res = await as(admin).put(`/api/employees/${employee.id}`).send({
      jobTitle: 'Warehouse Supervisor',
      nationalInsuranceNumber: 'QQ123456C',
      dateOfBirth: '1990-06-15',
      wageRate: '14.50',
      address: '1 Greenfield Road, Colne',
    });

    expect(res.status).toBe(200);
    const after = await reload(employee.id);
    expect(after.jobTitle).toBe('Warehouse Supervisor');
    expect(after.nationalInsuranceNumber).toBe('QQ123456C');
    expect(Number(after.wageRate)).toBe(14.5);
    expect(after.address).toBe('1 Greenfield Road, Colne');
  });

  it('stores the date of birth on the day given', async () => {
    // @db.Date built from local time stores the previous day east of UTC.
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();

    await as(admin)
      .put(`/api/employees/${employee.id}`)
      .send({ dateOfBirth: '1990-06-15' });

    const after = await reload(employee.id);
    expect(after.dateOfBirth.toISOString().slice(0, 10)).toBe('1990-06-15');
  });

  it('updates one field without disturbing the rest', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();
    await as(admin)
      .put(`/api/employees/${employee.id}`)
      .send({ jobTitle: 'Picker', address: 'Somewhere' });

    await as(admin).put(`/api/employees/${employee.id}`).send({ jobTitle: 'Packer' });

    const after = await reload(employee.id);
    expect(after.jobTitle).toBe('Packer');
    expect(after.address).toBe('Somewhere');
  });

  it('clears a field given a blank rather than storing an empty string', async () => {
    // Two employees with '' would collide on the unique NI index.
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();
    await as(admin)
      .put(`/api/employees/${employee.id}`)
      .send({ nationalInsuranceNumber: 'QQ111111A' });

    await as(admin)
      .put(`/api/employees/${employee.id}`)
      .send({ nationalInsuranceNumber: '   ' });

    const after = await reload(employee.id);
    expect(after.nationalInsuranceNumber).toBeNull();
  });

  it('404s an employee that does not exist', async () => {
    const admin = await makeAdmin();

    const res = await as(admin)
      .put('/api/employees/00000000-0000-0000-0000-000000000000')
      .send({ jobTitle: 'Ghost' });

    expect(res.status).toBe(404);
  });
});

describe('the allowlist', () => {
  it('refuses to set base salary, which payroll owns', async () => {
    // Payroll multiplies this into net pay. Two screens writing one number is
    // how they end up disagreeing.
    const admin = await makeAdmin();
    const { employee } = await makeEmployee({ baseSalary: '2000.00' });

    await as(admin)
      .put(`/api/employees/${employee.id}`)
      .send({ jobTitle: 'Picker', baseSalary: '999999.00' });

    const after = await reload(employee.id);
    expect(Number(after.baseSalary)).toBe(2000);
    expect(after.jobTitle).toBe('Picker');
  });

  it('refuses to move the record onto a different person', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();
    const other = await makeEmployee();

    await as(admin)
      .put(`/api/employees/${employee.id}`)
      .send({ jobTitle: 'Picker', userId: other.user.id });

    const after = await reload(employee.id);
    expect(after.userId).not.toBe(other.user.id);
  });

  it('refuses to rewrite the employee number', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();
    const original = employee.employeeUniqueNumber;

    await as(admin)
      .put(`/api/employees/${employee.id}`)
      .send({ jobTitle: 'Picker', employeeUniqueNumber: 'EMP-HACKED' });

    const after = await reload(employee.id);
    expect(after.employeeUniqueNumber).toBe(original);
  });
});

describe('what is refused', () => {
  it('a National Insurance number already used by someone else', async () => {
    // @unique in the schema. Left to Prisma this is a 500 naming a constraint,
    // which tells an admin nothing about what to do next.
    const admin = await makeAdmin();
    const first = await makeEmployee();
    const second = await makeEmployee();

    await as(admin)
      .put(`/api/employees/${first.employee.id}`)
      .send({ nationalInsuranceNumber: 'QQ222222B' });

    const res = await as(admin)
      .put(`/api/employees/${second.employee.id}`)
      .send({ nationalInsuranceNumber: 'QQ222222B' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already recorded against another employee/i);
  });

  it('a negative wage rate', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();

    const res = await as(admin)
      .put(`/api/employees/${employee.id}`)
      .send({ wageRate: '-5' });

    expect(res.status).toBe(400);
  });

  it('a date of birth in the future', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();

    const res = await as(admin)
      .put(`/api/employees/${employee.id}`)
      .send({ dateOfBirth: '2099-01-01' });

    expect(res.status).toBe(400);
  });

  it('a date of birth that is not a date', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();

    const res = await as(admin)
      .put(`/api/employees/${employee.id}`)
      .send({ dateOfBirth: 'last tuesday' });

    expect(res.status).toBe(400);
  });
});

describe('who may edit', () => {
  it('not an employee, not even their own record', async () => {
    // They can read their own; editing their job title or wage rate is not
    // theirs to do.
    const { user: employeeUser, employee } = await makeEmployee();

    const res = await as(employeeUser)
      .put(`/api/employees/${employee.id}`)
      .send({ jobTitle: 'Director' });

    expect(res.status).toBe(403);
  });

  it('not a client', async () => {
    const { user: clientUser } = await makeClient();
    const { employee } = await makeEmployee();

    const res = await as(clientUser)
      .put(`/api/employees/${employee.id}`)
      .send({ jobTitle: 'Anything' });

    expect(res.status).toBe(403);
  });

  it('not an anonymous caller', async () => {
    const { employee } = await makeEmployee();

    const res = await anon()
      .put(`/api/employees/${employee.id}`)
      .send({ jobTitle: 'Anything' });

    expect(res.status).toBe(401);
  });
});

describe('the audit trail', () => {
  it('records which fields changed, not their values', async () => {
    // The values are NI numbers and dates of birth; the log says what was
    // touched without copying that into a second place.
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();

    await as(admin)
      .put(`/api/employees/${employee.id}`)
      .send({ nationalInsuranceNumber: 'QQ333333C', jobTitle: 'Picker' });

    const log = await prisma.auditLog.findFirst({
      where: { action: 'EMPLOYEE_UPDATED' },
    });
    expect(log).not.toBeNull();
    expect(log.details).toContain('jobTitle');
    expect(log.details).not.toContain('QQ333333C');
  });
});
