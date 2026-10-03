/**
 * Admin edits and deletes that leave an entry in the activity log.
 *
 * What must hold:
 *   - Editing a client, a user (role, active state), a service, an agreed rate,
 *     a shift, a holiday or someone's attendance records who did it and what
 *     changed, before and after.
 *   - Adding or deleting an agreed rate, and deleting a shift, a holiday or an
 *     attendance log, records what it was.
 *   - An edit that changes nothing writes nothing.
 *   - Editing or deleting an attendance log that does not exist answers 404.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeAttendanceLog,
  makeClient,
  makeClientService,
  makeEmployee,
  makeHoliday,
  makeService,
  makeShift,
} from '../factories/index.js';

/** The entries written for one action, details parsed. */
const entries = async (action) =>
  (await prisma.auditLog.findMany({ where: { action } })).map((row) => ({
    ...row,
    details: JSON.parse(row.details),
  }));

/** The single entry for an action, checked to be the admin's. */
const onlyEntry = async (action, admin) => {
  const rows = await entries(action);
  expect(rows).toHaveLength(1);
  expect(rows[0].userId).toBe(admin.id);
  return rows[0].details;
};

describe('editing a client', () => {
  it('records what changed', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient({ contactName: 'Cara Client' });

    await as(admin).put(`/api/clients/${client.id}`).send({ contactName: 'Cara Jones', mobile: client.mobile });

    const details = await onlyEntry('UPDATE_CLIENT', admin);
    expect(details).toMatchObject({
      clientId: client.id,
      changed: ['contactName'],
      from: { contactName: 'Cara Client' },
      to: { contactName: 'Cara Jones' },
    });
  });

  it('writes nothing when nothing changed', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();

    await as(admin).put(`/api/clients/${client.id}`).send({ companyName: client.companyName });

    expect(await entries('UPDATE_CLIENT')).toHaveLength(0);
  });
});

describe('editing a user', () => {
  it('records a role change', async () => {
    const admin = await makeAdmin();
    const { user } = await makeEmployee();

    const res = await as(admin).put(`/api/users/${user.id}`).send({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(await onlyEntry('UPDATE_USER', admin)).toMatchObject({
      userId: user.id,
      changed: ['role'],
      from: { role: 'employee' },
      to: { role: 'admin' },
    });
  });
});

describe('editing a service', () => {
  it('records a price change', async () => {
    const admin = await makeAdmin();
    const service = await makeService({ ideaPrice: '2.50' });

    await as(admin).put(`/api/services/${service.id}`).send({ ideaPrice: 3 });

    expect(await onlyEntry('UPDATE_SERVICE', admin)).toMatchObject({
      serviceId: service.id,
      changed: ['ideaPrice'],
      from: { ideaPrice: 2.5 },
      to: { ideaPrice: 3 },
    });
  });
});

describe('agreed client rates', () => {
  it('are recorded when added, changed and deleted', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const service = await makeService();

    const added = await as(admin)
      .post('/api/client-services')
      .send({ clientId: client.id, serviceId: service.id, chargedPrice: 4, unit: 'item' });
    expect(added.status).toBe(201);
    expect(await onlyEntry('ADD_AGREED_RATE', admin)).toMatchObject({
      clientServiceId: added.body.id,
      companyName: client.companyName,
      service: service.description,
      chargedPrice: 4,
    });

    await as(admin).put(`/api/client-services/${added.body.id}`).send({ chargedPrice: 5 });
    expect(await onlyEntry('UPDATE_AGREED_RATE', admin)).toMatchObject({
      changed: ['chargedPrice'],
      from: { chargedPrice: 4 },
      to: { chargedPrice: 5 },
    });

    await as(admin).delete(`/api/client-services/${added.body.id}`);
    expect(await onlyEntry('DELETE_AGREED_RATE', admin)).toMatchObject({
      clientServiceId: added.body.id,
      chargedPrice: 5,
    });
  });

  it('answer 404 for one that does not exist', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const rate = await makeClientService(client.id, (await makeService()).id);
    await prisma.clientService.delete({ where: { id: rate.id } });

    expect((await as(admin).delete(`/api/client-services/${rate.id}`)).status).toBe(404);
    expect((await as(admin).put(`/api/client-services/${rate.id}`).send({ chargedPrice: 1 })).status).toBe(404);
  });
});

describe('shifts', () => {
  it('are recorded when edited and deleted', async () => {
    const admin = await makeAdmin();
    const shift = await makeShift({ name: 'evening' });

    await as(admin).put(`/api/shifts/${shift.id}`).send({ gracePeriodMins: 15 });
    expect(await onlyEntry('UPDATE_SHIFT', admin)).toMatchObject({
      shiftId: shift.id,
      changed: ['gracePeriodMins'],
      from: { gracePeriodMins: 10 },
      to: { gracePeriodMins: 15 },
    });

    await as(admin).delete(`/api/shifts/${shift.id}`);
    expect(await onlyEntry('DELETE_SHIFT', admin)).toMatchObject({ shiftId: shift.id, name: 'evening' });
  });
});

describe('holidays', () => {
  it('are recorded when edited and deleted', async () => {
    const admin = await makeAdmin();
    const holiday = await makeHoliday({ name: 'Christmas' });

    await as(admin).put(`/api/holidays/${holiday.id}`).send({ name: 'Christmas Day' });
    expect(await onlyEntry('UPDATE_HOLIDAY', admin)).toMatchObject({
      holidayId: holiday.id,
      changed: ['name'],
      from: { name: 'Christmas' },
      to: { name: 'Christmas Day' },
    });

    await as(admin).delete(`/api/holidays/${holiday.id}`);
    expect(await onlyEntry('DELETE_HOLIDAY', admin)).toMatchObject({ holidayId: holiday.id, name: 'Christmas Day' });
  });
});

describe('attendance logs', () => {
  it('are recorded when an admin corrects or deletes one, naming whose it was', async () => {
    const admin = await makeAdmin();
    const { user } = await makeEmployee({ user: { firstName: 'Ada', lastName: 'Lovelace' } });
    const log = await makeAttendanceLog(user.id);

    const res = await as(admin).put(`/api/attendance/${log.id}`).send({ status: 'late' });
    expect(res.status).toBe(200);
    expect(await onlyEntry('UPDATE_ATTENDANCE_LOG', admin)).toMatchObject({
      attendanceLogId: log.id,
      employeeName: 'Ada Lovelace',
      changed: ['status'],
      from: { status: 'on-time' },
      to: { status: 'late' },
    });

    await as(admin).delete(`/api/attendance/${log.id}`);
    expect(await onlyEntry('DELETE_ATTENDANCE_LOG', admin)).toMatchObject({
      attendanceLogId: log.id,
      employeeName: 'Ada Lovelace',
      status: 'late',
    });
  });

  it('answer 404 for one that does not exist', async () => {
    const admin = await makeAdmin();
    const missing = '00000000-0000-4000-8000-000000000000';

    expect((await as(admin).put(`/api/attendance/${missing}`).send({ status: 'late' })).status).toBe(404);
    expect((await as(admin).delete(`/api/attendance/${missing}`)).status).toBe(404);
  });
});
