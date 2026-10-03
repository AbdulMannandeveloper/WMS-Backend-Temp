/**
 * The automatic late fine, when an admin corrects the attendance it came from.
 *
 * Check-in fines a late arrival on its own. The fine does not point at the
 * log, so correcting the log used to leave it standing: someone marked
 * on-time after all was still docked for being late.
 *
 * What must hold:
 *   - Late to on-time (or leave), or deleting the late day, cancels the fine.
 *     Cancelled, not deleted: it stays on record like any cancelled fine.
 *   - Put back to late, it is restored.
 *   - Only that fine: a fine added by hand for the same day is left alone.
 *   - In a finalised month the correction is refused, as any fine change is
 *     there, and nothing is written.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeAttendanceLog,
  makeEmployee,
  makeEmployeeFine,
  makePayrollRecord,
} from '../factories/index.js';

const DAY = new Date('2026-08-03T00:00:00.000Z');

/** A late day, and the fine check-in raised for it. */
const arrange = async () => {
  const admin = await makeAdmin();
  const { user } = await makeEmployee();
  const log = await makeAttendanceLog(user.id, {
    status: 'late',
    loginTimestamp: new Date('2026-08-03T09:40:00.000Z'),
  });
  const fine = await makeEmployeeFine(user.id, { reason: 'Late check-in — 03/08/2026', date: DAY });
  return { admin, user, log, fine };
};

const cancelled = async (fine) =>
  (await prisma.employeeFine.findUnique({ where: { id: fine.id } })).cancelled;

describe('correcting a late day', () => {
  it('to on-time cancels its fine, and back to late restores it', async () => {
    const { admin, log, fine } = await arrange();

    expect((await as(admin).put(`/api/attendance/${log.id}`).send({ status: 'on-time' })).status).toBe(200);
    expect(await cancelled(fine)).toBe(true);

    expect((await as(admin).put(`/api/attendance/${log.id}`).send({ status: 'late' })).status).toBe(200);
    expect(await cancelled(fine)).toBe(false);
  });

  it('to leave cancels its fine too', async () => {
    const { admin, log, fine } = await arrange();

    await as(admin).put(`/api/attendance/${log.id}`).send({ status: 'leave' });

    expect(await cancelled(fine)).toBe(true);
  });

  it('by deleting it cancels its fine, and records that', async () => {
    const { admin, log, fine } = await arrange();

    expect((await as(admin).delete(`/api/attendance/${log.id}`)).status).toBe(200);

    expect(await cancelled(fine)).toBe(true);
    const entry = await prisma.auditLog.findFirst({ where: { action: 'TOGGLE_CANCEL_FINE' } });
    expect(JSON.parse(entry.details)).toMatchObject({ fineId: fine.id, cancelled: true, attendanceLogId: log.id });
  });

  it('leaves a fine added by hand for the same day alone', async () => {
    const { admin, user, log } = await arrange();
    const byHand = await makeEmployeeFine(user.id, { reason: 'Left the dock door open', date: DAY });

    await as(admin).put(`/api/attendance/${log.id}`).send({ status: 'on-time' });

    expect(await cancelled(byHand)).toBe(false);
  });

  it('leaves the fine when the status is not what changed', async () => {
    const { admin, log, fine } = await arrange();

    await as(admin)
      .put(`/api/attendance/${log.id}`)
      .send({ logoutTimestamp: '2026-08-03T18:00:00.000Z' });

    expect(await cancelled(fine)).toBe(false);
  });
});

describe('in a finalised month', () => {
  it('is refused, and changes nothing', async () => {
    const { admin, user, log, fine } = await arrange();
    await makePayrollRecord(user.id);

    const res = await as(admin).put(`/api/attendance/${log.id}`).send({ status: 'on-time' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Reopen the month/);
    expect((await prisma.employeeAttendanceLog.findUnique({ where: { id: log.id } })).status).toBe('late');
    expect(await cancelled(fine)).toBe(false);
  });
});
