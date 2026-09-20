/**
 * The attendance log list, and the roster built on top of it.
 *
 * The roster is the awkward one, and the reason is the axis. The screen lists
 * every member of staff and shows what each did on a day — so the rows are
 * people, and a log is something a row may or may not have. Page the logs
 * instead and anyone who did not clock in never appears, which is precisely the
 * person a roster is read for.
 *
 * Two of its five statuses are not stored anywhere: absent and holiday are the
 * same set of people, those with no log, and which name applies is decided by
 * the holiday calendar. Both must be filtered in the query rather than after
 * the page, or the total counts one thing while the rows show another.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeClient,
  makeAttendanceLog,
  makeHoliday,
  utcDate,
} from '../factories/index.js';

const DAY = utcDate(2026, 9, 10);
const DAY_ISO = '2026-09-10';

let admin;

beforeEach(async () => {
  admin = await makeAdmin();
});

describe('the log list', () => {
  it('answers { data, pagination } with the defaults applied', async () => {
    const { user } = await makeEmployee();
    for (let i = 1; i <= 3; i += 1) {
      await makeAttendanceLog(user.id, { date: utcDate(2026, 9, i) });
    }

    const res = await as(admin).get('/api/attendance');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination.total).toBe(3);
  });

  it('walks every row exactly once across pages', async () => {
    const { user } = await makeEmployee();
    for (let i = 1; i <= 7; i += 1) {
      await makeAttendanceLog(user.id, { date: utcDate(2026, 9, i) });
    }

    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await as(admin).get(`/api/attendance?page=${page}&limit=3`);
      seen.push(...res.body.data.map((r) => r.id));
    }

    expect(new Set(seen).size).toBe(7);
  });

  it('narrows by status, by person and by date range', async () => {
    const { user: a } = await makeEmployee({ user: { firstName: 'Ada' } });
    const { user: b } = await makeEmployee({ user: { firstName: 'Bob' } });

    await makeAttendanceLog(a.id, { date: utcDate(2026, 9, 1), status: 'late' });
    await makeAttendanceLog(a.id, { date: utcDate(2026, 9, 2), status: 'on-time' });
    await makeAttendanceLog(b.id, { date: utcDate(2026, 9, 3), status: 'late' });

    const late = await as(admin).get('/api/attendance?status=late');
    expect(late.body.pagination.total).toBe(2);

    const byUser = await as(admin).get(`/api/attendance?userId=${a.id}`);
    expect(byUser.body.pagination.total).toBe(2);

    const inRange = await as(admin).get(
      '/api/attendance?startDate=2026-09-02&endDate=2026-09-03',
    );
    expect(inRange.body.pagination.total).toBe(2);

    const byName = await as(admin).get('/api/attendance?search=Ada');
    expect(byName.body.pagination.total).toBe(2);
  });

  it('counts what the filter matched, not what the table holds', async () => {
    const { user } = await makeEmployee();
    await makeAttendanceLog(user.id, { date: utcDate(2026, 9, 1), status: 'late' });
    await makeAttendanceLog(user.id, { date: utcDate(2026, 9, 2), status: 'on-time' });
    await makeAttendanceLog(user.id, { date: utcDate(2026, 9, 3), status: 'on-time' });

    const res = await as(admin).get('/api/attendance?status=late&limit=2');

    expect(res.body.pagination.total).toBe(1);
  });

  it('refuses a status the column does not use', async () => {
    const res = await as(admin).get('/api/attendance?status=sleeping');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status must be one of/);
  });

  it('never returns a password hash with the person', async () => {
    const { user } = await makeEmployee();
    await makeAttendanceLog(user.id, { date: DAY });

    const res = await as(admin).get('/api/attendance');

    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });
});

describe('the roster', () => {
  it('lists people, including those with no log that day', async () => {
    const { user: present } = await makeEmployee({ user: { firstName: 'Wren' } });
    const { user: missing } = await makeEmployee({ user: { firstName: 'Bob' } });
    await makeAttendanceLog(present.id, { date: DAY, status: 'on-time' });

    const res = await as(admin).get(`/api/attendance/roster?date=${DAY_ISO}`);

    expect(res.status).toBe(200);
    // Two employees plus the admin, who is staff and belongs on the roster.
    expect(res.body.pagination.total).toBe(3);

    // Found by id, not by name: makeAdmin is called Ada, so matching on a
    // first name can silently pick the admin instead of the employee.
    const clockedIn = res.body.data.find((r) => r.user.id === present.id);
    const noShow = res.body.data.find((r) => r.user.id === missing.id);
    expect(clockedIn.effectiveStatus).toBe('on-time');
    expect(clockedIn.record).toBeTruthy();
    expect(noShow.effectiveStatus).toBe('absent');
    expect(noShow.record).toBeNull();
  });

  it('never lists a client', async () => {
    await makeClient();
    await makeEmployee();

    const res = await as(admin).get(`/api/attendance/roster?date=${DAY_ISO}`);

    expect(res.body.data.every((r) => r.user.role !== 'client')).toBe(true);
  });

  it('pages people, not logs', async () => {
    // Sixty staff, three of whom clocked in. A page of logs would be three
    // rows; a page of people is fifty.
    for (let i = 0; i < 60; i += 1) {
      const { user } = await makeEmployee({
        user: { firstName: `E${String(i).padStart(3, '0')}` },
      });
      if (i < 3) await makeAttendanceLog(user.id, { date: DAY, status: 'late' });
    }

    const page1 = await as(admin).get(
      `/api/attendance/roster?date=${DAY_ISO}&limit=50`,
    );
    const page2 = await as(admin).get(
      `/api/attendance/roster?date=${DAY_ISO}&page=2&limit=50`,
    );

    expect(page1.body.data).toHaveLength(50);
    expect(page1.body.pagination.total).toBe(61); // 60 employees + the admin
    expect(page2.body.data).toHaveLength(11);

    const seen = [
      ...page1.body.data.map((r) => r.user.id),
      ...page2.body.data.map((r) => r.user.id),
    ];
    expect(new Set(seen).size).toBe(61);
  });

  it('filters the synthesised absent status in the query, so the total agrees', async () => {
    const { user: present } = await makeEmployee();
    await makeEmployee();
    await makeEmployee();
    await makeAttendanceLog(present.id, { date: DAY, status: 'on-time' });

    const absent = await as(admin).get(
      `/api/attendance/roster?date=${DAY_ISO}&status=absent&limit=1`,
    );

    // Three people have no log: two employees and the admin. The total must
    // say three even though only one row came back.
    expect(absent.body.pagination.total).toBe(3);
    expect(absent.body.data).toHaveLength(1);
    expect(absent.body.data[0].effectiveStatus).toBe('absent');
  });

  it('filters a real status against the log for that day', async () => {
    const { user: late } = await makeEmployee();
    const { user: onTime } = await makeEmployee();
    await makeAttendanceLog(late.id, { date: DAY, status: 'late' });
    await makeAttendanceLog(onTime.id, { date: DAY, status: 'on-time' });

    const res = await as(admin).get(
      `/api/attendance/roster?date=${DAY_ISO}&status=late`,
    );

    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].user.id).toBe(late.id);
  });

  it('does not mistake another day for this one', async () => {
    const { user } = await makeEmployee();
    await makeAttendanceLog(user.id, { date: utcDate(2026, 9, 11), status: 'late' });

    const res = await as(admin).get(
      `/api/attendance/roster?date=${DAY_ISO}&status=late`,
    );

    expect(res.body.pagination.total).toBe(0);
  });

  it('searches by name and email', async () => {
    await makeEmployee({ user: { firstName: 'Ada', lastName: 'Lovelace' } });
    await makeEmployee({ user: { firstName: 'Bob', lastName: 'Barker' } });

    const byFullName = await as(admin).get(
      `/api/attendance/roster?date=${DAY_ISO}&search=Ada Lovelace`,
    );
    expect(byFullName.body.pagination.total).toBe(1);

    const bySurname = await as(admin).get(
      `/api/attendance/roster?date=${DAY_ISO}&search=Barker`,
    );
    expect(bySurname.body.pagination.total).toBe(1);
  });

  it('shows deactivated staff by default, and hides them on request', async () => {
    // Someone deactivated mid-month still worked the days before it, and a
    // roster that hides them loses those days.
    await makeEmployee({ user: { firstName: 'Gone', isActive: false } });
    await makeEmployee({ user: { firstName: 'Here', isActive: true } });

    const all = await as(admin).get(`/api/attendance/roster?date=${DAY_ISO}`);
    expect(all.body.data.some((r) => r.user.firstName === 'Gone')).toBe(true);

    const activeOnly = await as(admin).get(
      `/api/attendance/roster?date=${DAY_ISO}&isActive=true`,
    );
    expect(activeOnly.body.data.some((r) => r.user.firstName === 'Gone')).toBe(
      false,
    );
  });

  it('refuses a date it cannot read', async () => {
    const res = await as(admin).get('/api/attendance/roster?date=yesterday');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|P20\d\d/i);
  });
});

describe('the roster on a holiday', () => {
  beforeEach(async () => {
    await makeHoliday({ startDate: DAY, endDate: DAY, name: 'Founders Day' });
  });

  it('calls someone with no log on holiday rather than absent', async () => {
    await makeEmployee();

    const res = await as(admin).get(`/api/attendance/roster?date=${DAY_ISO}`);

    expect(res.body.data.every((r) => r.effectiveStatus === 'holiday')).toBe(
      true,
    );
  });

  it('still reports whoever did work that day', async () => {
    const { user } = await makeEmployee();
    await makeAttendanceLog(user.id, { date: DAY, status: 'on-time' });

    const res = await as(admin).get(`/api/attendance/roster?date=${DAY_ISO}`);

    const worker = res.body.data.find((r) => r.user.id === user.id);
    expect(worker.effectiveStatus).toBe('on-time');
  });

  it('answers an empty page for absent, because nobody can be absent today', async () => {
    await makeEmployee();

    const res = await as(admin).get(
      `/api/attendance/roster?date=${DAY_ISO}&status=absent`,
    );

    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it('and the mirror image on a working day', async () => {
    await makeEmployee();

    const res = await as(admin).get(
      '/api/attendance/roster?date=2026-09-11&status=holiday',
    );

    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });
});

describe('the roster summary', () => {
  it('counts each status across the whole filtered roster', async () => {
    const { user: a } = await makeEmployee();
    const { user: b } = await makeEmployee();
    await makeEmployee();
    await makeAttendanceLog(a.id, { date: DAY, status: 'on-time' });
    await makeAttendanceLog(b.id, { date: DAY, status: 'late' });

    const res = await as(admin).get(
      `/api/attendance/roster/summary?date=${DAY_ISO}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.onTime).toBe(1);
    expect(res.body.late).toBe(1);
    expect(res.body.leave).toBe(0);
    // One employee with no log, plus the admin.
    expect(res.body.absent).toBe(2);
    expect(res.body.holiday).toBe(0);
    expect(res.body.total).toBe(4);
  });

  it('adds up to the total', async () => {
    const { user } = await makeEmployee();
    await makeEmployee();
    await makeAttendanceLog(user.id, { date: DAY, status: 'leave' });

    const res = await as(admin).get(
      `/api/attendance/roster/summary?date=${DAY_ISO}`,
    );
    const { total, onTime, late, leave, absent, holiday } = res.body;

    expect(onTime + late + leave + absent + holiday).toBe(total);
  });

  it('moves the unlogged column on a holiday', async () => {
    await makeHoliday({ startDate: DAY, endDate: DAY, name: 'Founders Day' });
    await makeEmployee();

    const res = await as(admin).get(
      `/api/attendance/roster/summary?date=${DAY_ISO}`,
    );

    expect(res.body.absent).toBe(0);
    expect(res.body.holiday).toBe(2);
  });

  it('agrees with the roster it sits above', async () => {
    for (let i = 0; i < 5; i += 1) await makeEmployee();

    const list = await as(admin).get(
      `/api/attendance/roster?date=${DAY_ISO}&limit=1`,
    );
    const summary = await as(admin).get(
      `/api/attendance/roster/summary?date=${DAY_ISO}`,
    );

    expect(summary.body.total).toBe(list.body.pagination.total);
  });
});

describe('the by-field route the mobile app reads', () => {
  it('is still a bare array', async () => {
    const { user } = await makeEmployee();
    await makeAttendanceLog(user.id, { date: DAY });

    const res = await as(admin).get(`/api/attendance/userId/${user.id}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it('and /roster is not swallowed by it', async () => {
    await makeEmployee();

    const res = await as(admin).get(`/api/attendance/roster?date=${DAY_ISO}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pagination');
  });
});

describe('authorisation', () => {
  it('keeps the roster admin-only', async () => {
    const { user: employee } = await makeEmployee();

    expect((await as(employee).get('/api/attendance/roster')).status).toBe(403);
    expect(
      (await as(employee).get('/api/attendance/roster/summary')).status,
    ).toBe(403);
  });
});
