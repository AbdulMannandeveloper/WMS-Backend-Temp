/**
 * Editing and deleting shifts and holidays.
 *
 * What must hold:
 *   - The "default" shift — the one check-in times against, by name — is
 *     neither deleted nor renamed; the warning says why before the delete.
 *     Any other shift can go.
 *   - Edits change only the editable fields, and are checked against what is
 *     stored: one end of a range cannot be moved past the other, and moving a
 *     holiday's start does not collapse a multi-day holiday to one day.
 *   - A missing shift or holiday is a 404.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import { makeAdmin, makeEmployee, makeShift, makeHoliday } from '../factories/index.js';

const MISSING = '00000000-0000-0000-0000-000000000000';

describe('shifts', () => {
  it('keeps the default shift: the warning says so, and the delete is refused', async () => {
    const admin = await makeAdmin();
    const shift = await makeShift();

    const warning = await as(admin).get(`/api/shifts/${shift.id}/dependents`);
    expect(warning.status).toBe(200);
    expect(warning.body.canDelete).toBe(false);
    expect(warning.body.blocking.map((r) => r.key)).toEqual(['checkIn']);

    const res = await as(admin).delete(`/api/shifts/${shift.id}`);
    expect(res.status).toBe(409);
    expect(await prisma.shift.count({ where: { id: shift.id } })).toBe(1);
  });

  it('deletes any other shift', async () => {
    const admin = await makeAdmin();
    const night = await makeShift({ name: 'night' });

    expect((await as(admin).delete(`/api/shifts/${night.id}`)).status).toBe(200);
    expect(await prisma.shift.count({ where: { id: night.id } })).toBe(0);
  });

  it('does not rename the default shift, but changes its hours', async () => {
    const admin = await makeAdmin();
    const shift = await makeShift();

    expect((await as(admin).put(`/api/shifts/${shift.id}`).send({ name: 'day' })).status).toBe(400);

    const res = await as(admin)
      .put(`/api/shifts/${shift.id}`)
      .send({ startTime: '1970-01-01T09:00:00.000Z', gracePeriodMins: 5 });
    expect(res.status).toBe(200);
    expect(res.body.gracePeriodMins).toBe(5);
  });

  it('refuses a start moved past the stored end', async () => {
    const admin = await makeAdmin();
    const shift = await makeShift();

    const res = await as(admin)
      .put(`/api/shifts/${shift.id}`)
      .send({ startTime: '1970-01-01T18:00:00.000Z' });

    expect(res.status).toBe(400);
  });

  it('ignores fields an edit may not change', async () => {
    const admin = await makeAdmin();
    const shift = await makeShift({ name: 'night' });

    await as(admin).put(`/api/shifts/${shift.id}`).send({ id: MISSING, gracePeriodMins: 7 });

    expect(await prisma.shift.count({ where: { id: shift.id } })).toBe(1);
  });

  it('404s a shift that is not there', async () => {
    const admin = await makeAdmin();

    expect((await as(admin).put(`/api/shifts/${MISSING}`).send({ gracePeriodMins: 1 })).status).toBe(404);
    expect((await as(admin).get(`/api/shifts/${MISSING}/dependents`)).status).toBe(404);
  });

  it('keeps the warning to admins, as the delete is', async () => {
    const { user } = await makeEmployee();
    const shift = await makeShift();

    expect((await as(user).get(`/api/shifts/${shift.id}/dependents`)).status).toBe(403);
  });
});

describe('holidays', () => {
  it('moving the start keeps a multi-day holiday multi-day', async () => {
    const admin = await makeAdmin();
    const holiday = await makeHoliday({
      startDate: new Date(Date.UTC(2026, 11, 24)),
      endDate: new Date(Date.UTC(2026, 11, 27)),
    });

    const res = await as(admin)
      .put(`/api/holidays/${holiday.id}`)
      .send({ startDate: '2026-12-23T00:00:00.000Z' });

    expect(res.status).toBe(200);
    const after = await prisma.holiday.findUnique({ where: { id: holiday.id } });
    expect(after.startDate.toISOString().slice(0, 10)).toBe('2026-12-23');
    expect(after.endDate.toISOString().slice(0, 10)).toBe('2026-12-27');
  });

  it('refuses an end moved before the stored start', async () => {
    const admin = await makeAdmin();
    const holiday = await makeHoliday({
      startDate: new Date(Date.UTC(2026, 11, 24)),
      endDate: new Date(Date.UTC(2026, 11, 27)),
    });

    const res = await as(admin)
      .put(`/api/holidays/${holiday.id}`)
      .send({ endDate: '2026-12-20T00:00:00.000Z' });

    expect(res.status).toBe(400);
  });

  it('renames, refusing an empty name', async () => {
    const admin = await makeAdmin();
    const holiday = await makeHoliday();

    expect((await as(admin).put(`/api/holidays/${holiday.id}`).send({ name: 'Boxing Day' })).status).toBe(
      200,
    );
    expect((await as(admin).put(`/api/holidays/${holiday.id}`).send({ name: ' ' })).status).toBe(400);
  });

  it('404s a holiday that is not there', async () => {
    const admin = await makeAdmin();

    expect((await as(admin).put(`/api/holidays/${MISSING}`).send({ name: 'x' })).status).toBe(404);
    expect((await as(admin).delete(`/api/holidays/${MISSING}`)).status).toBe(404);
  });
});
