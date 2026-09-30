/**
 * Granting and revoking what an employee may do.
 *
 * This file covers the mechanism — the vocabulary, the endpoints, the cache.
 * Whether a particular route is governed by a particular permission is tested
 * beside that route.
 *
 * The test worth reading twice is the cache one. authorizeRoles serves the
 * actor from utils/authUserCache for up to AUTH_USER_CACHE_TTL_MS, 45 seconds
 * by default. A grant that does not invalidate that cache appears to do
 * nothing, and then starts working a minute later on its own — a bug that gets
 * diagnosed as "it fixed itself" and comes back per worker under pm2.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import { makeAdmin, makeEmployee, makeClient } from '../factories/index.js';
import {
  ALL_PERMISSIONS,
  normalisePermissions,
  holdsPermission,
} from '../../utils/permissions.js';

let admin;
let employee;
let employeeUser;

beforeEach(async () => {
  admin = await makeAdmin();
  const made = await makeEmployee();
  employee = made.employee;
  employeeUser = made.user;
});

describe('the vocabulary', () => {
  it('is sixteen permissions — four modules, four actions', () => {
    expect(ALL_PERMISSIONS).toHaveLength(16);
    expect(ALL_PERMISSIONS).toContain('shipments:create');
    expect(ALL_PERMISSIONS).toContain('fba:delete');
    expect(ALL_PERMISSIONS).toContain('inventory:update');
    expect(ALL_PERMISSIONS).toContain('freight:read');
  });

  it('refuses a string that is not one of them', () => {
    expect(() => normalisePermissions(['inventory:destroy'])).toThrow(
      /Unknown permission/,
    );
    // Not silently dropped: a typo that stored cleanly would look granted and
    // never match anything.
    expect(() => normalisePermissions(['payroll:read'])).toThrow(/payroll:read/);
  });

  it('names every unrecognised entry at once, not just the first', () => {
    expect(() => normalisePermissions(['a:b', 'inventory:read', 'c:d'])).toThrow(
      /a:b, c:d/,
    );
  });

  it('de-duplicates and orders, so two grants of one set compare equal', () => {
    const a = normalisePermissions(['inventory:read', 'shipments:create', 'inventory:read']);
    const b = normalisePermissions(['shipments:create', 'inventory:read']);

    expect(a).toEqual(b);
  });
});

describe('who the list governs', () => {
  it('an employee, by what they hold', () => {
    const user = { role: 'employee', permissions: ['inventory:read'] };

    expect(holdsPermission(user, 'inventory', 'read')).toBe(true);
    expect(holdsPermission(user, 'inventory', 'create')).toBe(false);
  });

  it('never an admin, whatever the column says', () => {
    // An empty list must not be able to lock out the person administering the
    // system.
    const user = { role: 'admin', permissions: [] };

    for (const action of ['create', 'read', 'update', 'delete']) {
      expect(holdsPermission(user, 'inventory', action)).toBe(true);
    }
  });

  it('never a client, whose access is narrowed by clientScope instead', () => {
    const user = { role: 'client', permissions: [] };

    expect(holdsPermission(user, 'shipments', 'read')).toBe(true);
  });

  it('treats a missing column as holding nothing, rather than throwing', () => {
    // A row written before the column existed reads as null.
    expect(holdsPermission({ role: 'employee' }, 'inventory', 'read')).toBe(false);
    expect(holdsPermission(null, 'inventory', 'read')).toBe(false);
  });
});

describe('reading a permission set', () => {
  it('starts empty for a new employee', async () => {
    const res = await as(admin).get(`/api/employees/${employee.id}/permissions`);

    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual([]);
    expect(res.body.role).toBe('employee');
  });

  it('is readable by that employee, who needs it to know what to offer', async () => {
    const res = await as(employeeUser).get(
      `/api/employees/${employee.id}/permissions`,
    );

    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual([]);
  });

  it('is not readable by another employee', async () => {
    const other = await makeEmployee();

    const res = await as(other.user).get(
      `/api/employees/${employee.id}/permissions`,
    );

    expect(res.status).toBe(403);
  });

  it('needs a session', async () => {
    const res = await anon().get(`/api/employees/${employee.id}/permissions`);

    expect(res.status).toBe(401);
  });
});

describe('writing a permission set', () => {
  it('replaces the whole set, so an unticked box is a revocation', async () => {
    await as(admin)
      .put(`/api/employees/${employee.id}/permissions`)
      .send({ permissions: ['inventory:read', 'inventory:create'] });

    const res = await as(admin)
      .put(`/api/employees/${employee.id}/permissions`)
      .send({ permissions: ['inventory:read'] });

    expect(res.status).toBe(200);
    // A diff would have left create in place: nothing sent is indistinguishable
    // from leave it alone.
    expect(res.body.permissions).toEqual(['inventory:read']);
  });

  it('refuses an unknown permission rather than storing it', async () => {
    const res = await as(admin)
      .put(`/api/employees/${employee.id}/permissions`)
      .send({ permissions: ['inventory:read', 'inventory:destroy'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inventory:destroy/);

    const after = await prisma.user.findUnique({ where: { id: employeeUser.id } });
    expect(after.permissions).toEqual([]);
  });

  it('refuses a body that is not a list', async () => {
    const res = await as(admin)
      .put(`/api/employees/${employee.id}/permissions`)
      .send({ permissions: 'inventory:read' });

    expect(res.status).toBe(400);
  });

  it('treats an absent list as clearing, not as a no-op', async () => {
    await as(admin)
      .put(`/api/employees/${employee.id}/permissions`)
      .send({ permissions: ['inventory:read'] });

    const res = await as(admin)
      .put(`/api/employees/${employee.id}/permissions`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual([]);
  });

  it('is admin only', async () => {
    const res = await as(employeeUser)
      .put(`/api/employees/${employee.id}/permissions`)
      .send({ permissions: ['inventory:read'] });

    expect(res.status).toBe(403);
  });

  it('refuses a login that is not an employee', async () => {
    // An admin is never governed by the list, so a screen offering to set one
    // would appear to work and change nothing.
    const adminEmployee = await makeEmployee({ user: { role: 'admin' } });

    const res = await as(admin)
      .put(`/api/employees/${adminEmployee.employee.id}/permissions`)
      .send({ permissions: ['inventory:read'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/employee role only/i);
  });

  it('404s an employment record that does not exist', async () => {
    const res = await as(admin)
      .put('/api/employees/00000000-0000-0000-0000-000000000000/permissions')
      .send({ permissions: [] });

    expect(res.status).toBe(404);
  });

  it('records the grant and the revocation in the audit log', async () => {
    await as(admin)
      .put(`/api/employees/${employee.id}/permissions`)
      .send({ permissions: ['inventory:read', 'inventory:create'] });
    await as(admin)
      .put(`/api/employees/${employee.id}/permissions`)
      .send({ permissions: ['inventory:read', 'fba:read'] });

    const logs = await prisma.auditLog.findMany({
      where: { action: 'SET_EMPLOYEE_PERMISSIONS' },
      orderBy: { timestamp: 'asc' },
    });

    expect(logs).toHaveLength(2);
    const second = JSON.parse(logs[1].details);
    expect(second.granted).toEqual(['fba:read']);
    expect(second.revoked).toEqual(['inventory:create']);
  });
});

describe('what a write leaves behind', () => {
  it('stores exactly the normalised set', async () => {
    await as(admin)
      .put(`/api/employees/${employee.id}/permissions`)
      .send({ permissions: ['inventory:create', 'fba:read', 'fba:read'] });

    const stored = await prisma.user.findUnique({ where: { id: employeeUser.id } });

    // De-duplicated and in the canonical order, so two grants of one set are
    // the same value and an audit diff of them is empty.
    expect(stored.permissions).toEqual(['fba:read', 'inventory:create']);
  });

  /**
   * The cache is deliberately not asserted here.
   *
   * setEmployeePermissions calls invalidateCachedUser, and that call is what
   * makes a grant take effect before AUTH_USER_CACHE_TTL_MS elapses. But it is
   * unobservable from this file: the read endpoint goes to the database
   * directly, and the cached row only decides what authorizeRoles puts on
   * req.user — which nothing consumes until a route is governed.
   *
   * An earlier version of this test read the permissions back over HTTP and
   * passed with the invalidation commented out, which is worse than no test.
   * The real one lives beside the first governed route: grant, then call that
   * route with the same token and expect it to answer. Without the
   * invalidation that fails for forty-five seconds and then starts passing.
   */
});

describe('what the front end is told at sign-in', () => {
  it('a client is unaffected by any of this', async () => {
    const { user: clientUser } = await makeClient();

    // A client holds no permissions and must not need any: its access is
    // narrowed by clientScope, not by this list.
    const fresh = await prisma.user.findUnique({ where: { id: clientUser.id } });
    expect(fresh.permissions).toEqual([]);
    expect(holdsPermission({ role: 'client', permissions: [] }, 'fba', 'read')).toBe(
      true,
    );
  });
});
