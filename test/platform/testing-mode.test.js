// TESTING-ONLY (whole file) — delete it with the rest; see TESTING_RELAXATIONS.md.

/**
 * The switch for the deletes allowed while the company tests on live data.
 *
 * What must hold:
 *   - Off until an admin turns it on from the app.
 *   - On for a week from then; pressing it again does not extend the week.
 *   - After the week it is off, and says it has expired, until an admin
 *     dismisses it or turns it on for another week.
 *   - An admin can turn it off at any time.
 *   - Turning it on and off is recorded.
 *   - Only admins may read or change it.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import { makeAdmin, makeEmployee } from '../factories/index.js';
import testingModeLogic from '../../logic/testing_mode.logic.js';

const { testingDeletesStatus, turnOnTestingDeletes, RUNS_FOR_MS } = testingModeLogic;

const START = new Date('2026-10-05T09:00:00.000Z');
const later = (ms) => new Date(START.getTime() + ms);
const DAY = 24 * 60 * 60 * 1000;

describe('the testing-deletes switch', () => {
  it('is off until an admin turns it on', async () => {
    const admin = await makeAdmin();

    expect((await as(admin).get('/api/testing-mode')).body).toEqual({
      enabled: false,
      expired: false,
      startedAt: null,
      until: null,
    });

    const res = await as(admin).post('/api/testing-mode');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, expired: false });
    expect(new Date(res.body.until).getTime() - new Date(res.body.startedAt).getTime()).toBe(RUNS_FOR_MS);
    const entry = await prisma.auditLog.findFirst({ where: { action: 'TESTING_MODE_ON' } });
    expect(entry.userId).toBe(admin.id);
  });

  it('runs for a week, and pressing it again does not extend it', async () => {
    await turnOnTestingDeletes(null, START);
    await turnOnTestingDeletes(null, later(3 * DAY));

    expect(await testingDeletesStatus({ now: later(RUNS_FOR_MS - 1) })).toMatchObject({
      enabled: true,
      until: '2026-10-12T09:00:00.000Z',
    });
  });

  it('is off once the week is over, and says it has expired', async () => {
    await turnOnTestingDeletes(null, START);

    expect(await testingDeletesStatus({ now: later(RUNS_FOR_MS) })).toEqual({
      enabled: false,
      expired: true,
      startedAt: START.toISOString(),
      until: '2026-10-12T09:00:00.000Z',
    });
  });

  it('can be turned on for another week once expired', async () => {
    await turnOnTestingDeletes(null, START);
    const again = later(10 * DAY);

    await turnOnTestingDeletes(null, again);

    expect(await testingDeletesStatus({ now: again })).toMatchObject({
      enabled: true,
      startedAt: again.toISOString(),
    });
  });

  it('can be turned off, or an expired week dismissed, by an admin', async () => {
    const admin = await makeAdmin();
    await as(admin).post('/api/testing-mode');

    const res = await as(admin).delete('/api/testing-mode');

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect((await testingDeletesStatus()).enabled).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'TESTING_MODE_OFF' } })).toBe(1);
  });

  it('is admin-only', async () => {
    const { user } = await makeEmployee();

    expect((await as(user).get('/api/testing-mode')).status).toBe(403);
    expect((await as(user).post('/api/testing-mode')).status).toBe(403);
    expect((await as(user).delete('/api/testing-mode')).status).toBe(403);
    expect((await testingDeletesStatus()).enabled).toBe(false);
  });
});
