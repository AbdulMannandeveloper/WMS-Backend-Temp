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
import {
  makeAdmin,
  makeClient,
  makeClientService,
  makeEmployee,
  makeInvoice,
  makeProduct,
  makeService,
  makeShipment,
} from '../factories/index.js';

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

describe('editing a client', () => {
  it('is possible at all — the route was missing entirely', async () => {
    // updateClient and deleteClient existed in the controller and logic with no
    // route pointing at either, so a client's details could never be corrected
    // after creation.
    const admin = await makeAdmin();
    const { client } = await makeClient();

    const res = await as(admin)
      .put(`/api/clients/${client.id}`)
      .send({ companyName: 'Renamed Ltd' });

    expect(res.status).toBe(200);
    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after.companyName).toBe('Renamed Ltd');
  });

  it('is admin only', async () => {
    const { user: employeeUser } = await makeEmployee();
    const { client } = await makeClient();

    const res = await as(employeeUser)
      .put(`/api/clients/${client.id}`)
      .send({ companyName: 'Nope' });

    expect(res.status).toBe(403);
  });

  it('a client cannot rename themselves', async () => {
    const { client, user: clientUser } = await makeClient();

    const res = await as(clientUser)
      .put(`/api/clients/${client.id}`)
      .send({ companyName: 'Self Service Ltd' });

    expect(res.status).toBe(403);
  });

  it('ignores fields outside the allowlist', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();

    await as(admin)
      .put(`/api/clients/${client.id}`)
      .send({ companyName: 'Fine', clientUniqueNumber: 'CLT-HACKED' });

    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after.companyName).toBe('Fine');
    expect(after.clientUniqueNumber).not.toBe('CLT-HACKED');
  });
});

describe('editing a client email', () => {
  it('moves the login with it', async () => {
    const admin = await makeAdmin();
    const { client, user } = await makeClient();
    const email = `moved-${Math.random().toString(36).slice(2, 8)}@example.test`;

    const res = await as(admin).put(`/api/clients/${client.id}`).send({ email });

    expect(res.status).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: user.id } })).email).toBe(email);
  });

  it('refuses an address another login already uses', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const { user: other } = await makeClient();

    const res = await as(admin).put(`/api/clients/${client.id}`).send({ email: other.email });

    expect(res.status).toBe(400);
    expect((await prisma.client.findUnique({ where: { id: client.id } })).email).toBe(client.email);
  });
});

describe('deleting a client', () => {
  it('deletes one with nothing on record, login and rates included', async () => {
    const admin = await makeAdmin();
    const { client, user } = await makeClient();
    const service = await makeService();
    await makeClientService(client.id, service.id);

    const res = await as(admin).delete(`/api/clients/${client.id}`);

    expect(res.status).toBe(200);
    expect(await prisma.client.findUnique({ where: { id: client.id } })).toBeNull();
    // Deleting only the Client row used to leave this login behind.
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await prisma.clientService.count({ where: { clientId: client.id } })).toBe(0);
  });

  it('lists what is in the way before anything is pressed', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();
    const { client } = await makeClient();
    await makeProduct(client.id);
    await makeShipment(employee.id, client.id);
    await makeInvoice(client.id);
    const service = await makeService();
    await makeClientService(client.id, service.id);

    const res = await as(admin).get(`/api/clients/${client.id}/dependents`);

    expect(res.status).toBe(200);
    expect(res.body.canDelete).toBe(false);
    const counts = Object.fromEntries(res.body.blocking.map((r) => [r.key, r.count]));
    expect(counts).toEqual({ products: 1, shipments: 1, invoices: 1 });
    expect(res.body.removedWith.map((r) => r.key)).toEqual(['clientServices']);
  });

  it('refuses while records remain, says why, and deletes nothing', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();
    const { client, user } = await makeClient();
    await makeShipment(employee.id, client.id);

    const res = await as(admin).delete(`/api/clients/${client.id}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HAS_DEPENDENTS');
    expect(res.body.dependents.blocking[0].key).toBe('shipments');
    expect(await prisma.client.findUnique({ where: { id: client.id } })).not.toBeNull();
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
  });

  it('goes through once the records are cleared', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();
    const { client } = await makeClient();
    const shipment = await makeShipment(employee.id, client.id);

    expect((await as(admin).delete(`/api/clients/${client.id}`)).status).toBe(409);
    await prisma.shipment.delete({ where: { id: shipment.id } });

    expect((await as(admin).delete(`/api/clients/${client.id}`)).status).toBe(200);
  });

  it('is admin only', async () => {
    const { user: employeeUser } = await makeEmployee();
    const { client } = await makeClient();

    expect((await as(employeeUser).delete(`/api/clients/${client.id}`)).status).toBe(403);
    expect((await as(employeeUser).get(`/api/clients/${client.id}/dependents`)).status).toBe(403);
  });
});

describe('deactivating a client', () => {
  it('switches the login off and back on, keeping the records', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();
    const { client, user } = await makeClient({ user: { passwordHash: 'set' } });
    await makeShipment(employee.id, client.id);

    const off = await as(admin).patch(`/api/clients/${client.id}/active`).send({ isActive: false });
    expect(off.status).toBe(200);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.isActive).toBe(false);
    // Ends sessions already issued.
    expect(after.tokenVersion).toBe(user.tokenVersion + 1);

    const list = await as(admin).get('/api/clients');
    expect(list.body.find((c) => c.id === client.id).accountStatus).toBe('inactive');

    const on = await as(admin).patch(`/api/clients/${client.id}/active`).send({ isActive: true });
    expect(on.status).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: user.id } })).isActive).toBe(true);
  });

  it('refuses a client who never set a password — there is no login yet', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();

    const res = await as(admin).patch(`/api/clients/${client.id}/active`).send({ isActive: false });

    expect(res.status).toBe(400);
  });

  it('never sends the password hash to the list', async () => {
    const admin = await makeAdmin();
    await makeClient({ user: { passwordHash: 'secret-hash' } });

    const res = await as(admin).get('/api/clients');

    expect(JSON.stringify(res.body)).not.toContain('secret-hash');
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
