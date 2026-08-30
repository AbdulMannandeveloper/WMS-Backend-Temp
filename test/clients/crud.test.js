/**
 * Clients.
 *
 * Adding a client creates two rows — a User with role 'client' and the Client
 * business record — plus an invitation token and an email. That sequence is
 * NOT in a database transaction; logic/client.logic.js rolls the user back by
 * hand in a catch block. The tests below hold that rollback shut, because a
 * half-created client leaves an orphan User occupying the email address, and
 * the second attempt then fails with "a user with this email already exists"
 * for a client that does not exist.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import { makeAdmin, makeClient, makeEmployee } from '../factories/index.js';

const body = (overrides = {}) => ({
  companyName: 'Acme Distribution',
  contactName: 'Jane Doe',
  email: `client-${Math.random().toString(36).slice(2, 10)}@example.test`,
  mobile: '07700900000',
  address: '1 Warehouse Way',
  ...overrides,
});

describe('adding a client', () => {
  it('creates the user and the client together', async () => {
    const admin = await makeAdmin();
    const payload = body();

    const res = await as(admin).post('/api/clients').send(payload);

    expect(res.status).toBe(201);
    const user = await prisma.user.findUnique({ where: { email: payload.email } });
    expect(user.role).toBe('client');
    const client = await prisma.client.findFirst({ where: { userId: user.id } });
    expect(client.companyName).toBe('Acme Distribution');
  });

  it('leaves the account inactive until the invite is accepted', async () => {
    const admin = await makeAdmin();
    const payload = body();

    await as(admin).post('/api/clients').send(payload);

    const user = await prisma.user.findUnique({ where: { email: payload.email } });
    expect(user.isActive).toBe(false);
    expect(user.passwordHash).toBeNull();
  });

  it('splits the contact name into first and last', async () => {
    const admin = await makeAdmin();
    const payload = body({ contactName: 'Mary Jane Watson' });

    await as(admin).post('/api/clients').send(payload);

    const user = await prisma.user.findUnique({ where: { email: payload.email } });
    expect(user.firstName).toBe('Mary');
    expect(user.lastName).toBe('Jane Watson');
  });

  it('copes with a single-word contact name', async () => {
    const admin = await makeAdmin();
    const payload = body({ contactName: 'Prince' });

    const res = await as(admin).post('/api/clients').send(payload);

    expect(res.status).toBe(201);
  });

  it('gives every client a distinct client number', async () => {
    const admin = await makeAdmin();

    await Promise.all([
      as(admin).post('/api/clients').send(body()),
      as(admin).post('/api/clients').send(body()),
      as(admin).post('/api/clients').send(body()),
    ]);

    const numbers = (
      await prisma.client.findMany({ select: { clientUniqueNumber: true } })
    ).map((c) => c.clientUniqueNumber);

    expect(new Set(numbers).size).toBe(numbers.length);
    for (const n of numbers) expect(n).toMatch(/^CLT-[0-9A-F]{8}$/);
  });

  it('requires company, contact and email', async () => {
    const admin = await makeAdmin();

    const res = await as(admin)
      .post('/api/clients')
      .send({ companyName: 'Only This' });

    expect(res.status).toBe(400);
  });

  it('rejects a malformed email', async () => {
    const admin = await makeAdmin();

    const res = await as(admin).post('/api/clients').send(body({ email: 'nope' }));

    expect(res.status).toBe(400);
  });

  it('refuses a duplicate email and creates nothing', async () => {
    const admin = await makeAdmin();
    const { user: existing } = await makeClient();

    const res = await as(admin)
      .post('/api/clients')
      .send(body({ email: existing.email }));

    expect(res.status).toBe(400);
    expect(await prisma.user.count({ where: { email: existing.email } })).toBe(1);
  });

  it('leaves no orphan user behind when the client row fails', async () => {
    // The non-transactional path, exercised. companyName is VarChar-bounded, so
    // an over-long one fails at the Client insert — after the User is created.
    const admin = await makeAdmin();
    const payload = body({ companyName: 'X'.repeat(5000) });

    const res = await as(admin).post('/api/clients').send(payload);

    expect(res.status).toBe(400);
    const orphan = await prisma.user.findUnique({ where: { email: payload.email } });
    expect(orphan).toBeNull();
  });
});

describe('who may do what', () => {
  it('only an admin adds a client', async () => {
    const { user: employeeUser } = await makeEmployee();
    expect((await as(employeeUser).post('/api/clients').send(body())).status).toBe(403);
  });

  it('only an admin lists them all', async () => {
    const { user: employeeUser } = await makeEmployee();
    expect((await as(employeeUser).get('/api/clients')).status).toBe(403);
  });

  it('staff may use the lookup, which is the narrow read they need', async () => {
    const { user: employeeUser } = await makeEmployee();
    expect((await as(employeeUser).get('/api/clients/lookup')).status).toBe(200);
  });

  it('a client may read their own record', async () => {
    const { user: clientUser } = await makeClient();
    const res = await as(clientUser).get('/api/clients/me');
    expect(res.status).toBe(200);
  });

  it('a client cannot list every other client', async () => {
    const { user: clientUser } = await makeClient();
    expect((await as(clientUser).get('/api/clients')).status).toBe(403);
  });

  it('refuses anonymous requests', async () => {
    expect((await anon().get('/api/clients')).status).toBe(401);
  });
});
