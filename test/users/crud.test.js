/**
 * User administration.
 *
 * The security-critical part here is not the CRUD, it is that deactivating
 * someone or changing their role must end the sessions they already hold. A
 * stateless JWT keeps working until it expires otherwise: a sacked employee
 * carries on for the rest of the token's life, and a demoted admin keeps admin
 * rights in the token already in their pocket.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import { makeAdmin, makeUser, makeEmployee } from '../factories/index.js';

/** A user who has completed setup — isActive is only togglable after that. */
const makeSetUpUser = (overrides = {}) =>
  makeUser({ passwordHash: 'x'.repeat(60), isActive: true, ...overrides });

describe('creating a user', () => {
  it('is admin only', async () => {
    const { user: employeeUser } = await makeEmployee();

    const res = await as(employeeUser)
      .post('/api/users/add')
      .send({ firstName: 'New', lastName: 'Person', email: 'new@example.test' });

    expect(res.status).toBe(403);
  });

  it('is refused outright without a session', async () => {
    const res = await anon()
      .post('/api/users/add')
      .send({ firstName: 'New', lastName: 'Person', email: 'new@example.test' });

    expect(res.status).toBe(401);
  });

  it('rejects a malformed email', async () => {
    const admin = await makeAdmin();

    const res = await as(admin)
      .post('/api/users/add')
      .send({ firstName: 'New', lastName: 'Person', email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('refuses a duplicate email rather than creating a second account', async () => {
    const admin = await makeAdmin();
    const existing = await makeUser();

    const res = await as(admin)
      .post('/api/users/add')
      .send({ firstName: 'Copy', lastName: 'Cat', email: existing.email });

    expect(res.status).toBe(400);
    const count = await prisma.user.count({ where: { email: existing.email } });
    expect(count).toBe(1);
  });

  it('creates the account inactive, with no password set', async () => {
    // The account only becomes usable once the invitee follows the setup link.
    const admin = await makeAdmin();

    const res = await as(admin)
      .post('/api/users/add')
      .send({ firstName: 'New', lastName: 'Person', email: 'fresh@example.test' });

    expect(res.status).toBe(201);
    const created = await prisma.user.findUnique({
      where: { email: 'fresh@example.test' },
    });
    expect(created.isActive).toBe(false);
    expect(created.passwordHash).toBeNull();
  });

  it('never returns a password hash', async () => {
    const admin = await makeAdmin();

    const res = await as(admin)
      .post('/api/users/add')
      .send({ firstName: 'New', lastName: 'Person', email: 'quiet@example.test' });

    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });
});

describe('changing a user', () => {
  it('bumps tokenVersion when deactivating, ending their sessions', async () => {
    // The whole point. Without this a deactivated account keeps working.
    const admin = await makeAdmin();
    const target = await makeSetUpUser();
    const before = target.tokenVersion;

    const res = await as(admin)
      .put(`/api/users/${target.id}`)
      .send({ isActive: false });

    expect(res.status).toBe(200);
    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after.tokenVersion).toBe(before + 1);
  });

  it('bumps tokenVersion when changing role, so a demotion takes effect now', async () => {
    const admin = await makeAdmin();
    const target = await makeSetUpUser({ role: 'admin' });
    const before = target.tokenVersion;

    await as(admin).put(`/api/users/${target.id}`).send({ role: 'employee' });

    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after.tokenVersion).toBe(before + 1);
  });

  it('does not bump tokenVersion for a harmless edit', async () => {
    // Signing everyone out because a surname was corrected would be its own bug.
    const admin = await makeAdmin();
    const target = await makeSetUpUser();

    await as(admin).put(`/api/users/${target.id}`).send({ lastName: 'Renamed' });

    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after.tokenVersion).toBe(target.tokenVersion);
  });

  it('refuses an unknown role', async () => {
    const admin = await makeAdmin();
    const target = await makeSetUpUser();

    const res = await as(admin)
      .put(`/api/users/${target.id}`)
      .send({ role: 'superuser' });

    expect(res.status).toBe(400);
  });

  it('will not set a password through this route', async () => {
    // Passwords are only ever set through the invitation/reset token flow.
    const admin = await makeAdmin();
    const target = await makeSetUpUser();

    await as(admin)
      .put(`/api/users/${target.id}`)
      .send({ passwordHash: 'injected' });

    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after.passwordHash).not.toBe('injected');
  });

  it('refuses to activate someone who has not completed setup', async () => {
    const admin = await makeAdmin();
    const pending = await makeUser({ passwordHash: null, isActive: false });

    const res = await as(admin)
      .put(`/api/users/${pending.id}`)
      .send({ isActive: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password setup/i);
  });

  it('404s on a user that does not exist', async () => {
    const admin = await makeAdmin();

    const res = await as(admin)
      .put('/api/users/00000000-0000-0000-0000-000000000000')
      .send({ lastName: 'Nobody' });

    expect([400, 404]).toContain(res.status);
  });
});

describe('reading users', () => {
  it('is admin only', async () => {
    const { user: employeeUser } = await makeEmployee();
    expect((await as(employeeUser).get('/api/users/')).status).toBe(403);
  });

  it('never leaks password hashes in the list', async () => {
    const admin = await makeAdmin();
    await makeSetUpUser();

    const res = await as(admin).get('/api/users/');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });
});
