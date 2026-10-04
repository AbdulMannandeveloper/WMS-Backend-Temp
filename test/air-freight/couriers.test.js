/**
 * Couriers and their depots — the reference data the module is configured with.
 *
 * Writing couriers is admin-only reference work, whatever an employee has been
 * granted on air freight; reading the list is open to clients too, because they
 * need the valid codes to fill in a manifest, but trimmed to id/code/name. A
 * courier that boxes or handovers point at is deactivated rather than deleted.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeClient,
  makeCourier,
  makeAirFreightBox,
  grantPermissions,
} from '../factories/index.js';

let admin;

beforeEach(async () => {
  admin = await makeAdmin();
});

const courierBody = (overrides = {}) => ({
  code: 'ups',
  name: 'UPS',
  trackingRegex: '^1Z[0-9A-Z]{16}$',
  trackingUrlTemplate: 'https://www.ups.com/track?tracknum={tracking}',
  ...overrides,
});

describe('creating a courier', () => {
  it('uppercases the code and stores the regex and URL', async () => {
    const res = await as(admin).post('/api/couriers').send(courierBody());

    expect(res.status).toBe(201);
    expect(res.body.code).toBe('UPS');
    expect(res.body.name).toBe('UPS');
    expect(res.body.trackingRegex).toBe('^1Z[0-9A-Z]{16}$');
    expect(res.body.depots).toEqual([]);
  });

  it('refuses a duplicate code', async () => {
    await as(admin).post('/api/couriers').send(courierBody());
    const again = await as(admin).post('/api/couriers').send(courierBody({ name: 'UPS 2' }));
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already exists/i);
  });

  it('refuses an invalid regex rather than crashing', async () => {
    const res = await as(admin).post('/api/couriers').send(courierBody({ trackingRegex: '([' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a valid regular expression/i);
  });

  it('accepts a courier with no regex', async () => {
    const res = await as(admin).post('/api/couriers').send(courierBody({ trackingRegex: null }));
    expect(res.status).toBe(201);
    expect(res.body.trackingRegex).toBeNull();
  });

  it('is admin-only and needs a session', async () => {
    const { user: employee } = await makeEmployee();
    await grantPermissions(employee, ['airfreight:create', 'airfreight:update']);
    expect((await as(employee).post('/api/couriers').send(courierBody())).status).toBe(403);
    expect((await anon().post('/api/couriers').send(courierBody())).status).toBe(401);
  });
});

describe('reading the courier list', () => {
  beforeEach(async () => {
    await makeCourier({ code: 'DPD', name: 'DPD', isActive: true });
    await makeCourier({ code: 'OLD', name: 'Retired', isActive: false });
  });

  it('gives staff the full rows', async () => {
    const res = await as(admin).get('/api/couriers');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body[0]).toHaveProperty('depots');
  });

  it('filters to active with ?active=true', async () => {
    const res = await as(admin).get('/api/couriers?active=true');
    expect(res.body.every((c) => c.isActive)).toBe(true);
    expect(res.body.some((c) => c.code === 'OLD')).toBe(false);
  });

  it('gives a client only id, code and name', async () => {
    const { user: clientUser } = await makeClient();
    const res = await as(clientUser).get('/api/couriers?active=true');
    expect(res.status).toBe(200);
    const row = res.body.find((c) => c.code === 'DPD');
    expect(Object.keys(row).sort()).toEqual(['code', 'id', 'name']);
  });
});

describe('updating and deleting a courier', () => {
  it('deletes a courier nothing points at', async () => {
    const courier = await makeCourier();
    const res = await as(admin).delete(`/api/couriers/${courier.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.courier.findUnique({ where: { id: courier.id } })).toBeNull();
  });

  it('blocks deletion of a courier a box uses, offering deactivation', async () => {
    const courier = await makeCourier();
    await makeAirFreightBox(undefined, courier.id);

    const res = await as(admin).delete(`/api/couriers/${courier.id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HAS_DEPENDENTS');
    expect(res.body.dependents.canDelete).toBe(false);

    // Deactivating is the way out.
    const off = await as(admin).put(`/api/couriers/${courier.id}`).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
  });

  it('reports dependents before a delete', async () => {
    const courier = await makeCourier();
    await makeAirFreightBox(undefined, courier.id);
    const res = await as(admin).get(`/api/couriers/${courier.id}/dependents`);
    expect(res.status).toBe(200);
    expect(res.body.canDelete).toBe(false);
    expect(res.body.blocking.some((b) => b.key === 'boxes')).toBe(true);
  });
});

describe('depots', () => {
  it('adds, updates and deletes a depot', async () => {
    const courier = await makeCourier();

    const added = await as(admin)
      .post(`/api/couriers/${courier.id}/depots`)
      .send({ name: 'Hub A', address: '1 Depot Way' });
    expect(added.status).toBe(201);
    expect(added.body.name).toBe('Hub A');

    const updated = await as(admin)
      .put(`/api/couriers/depots/${added.body.id}`)
      .send({ address: '2 Depot Way' });
    expect(updated.body.address).toBe('2 Depot Way');

    const removed = await as(admin).delete(`/api/couriers/depots/${added.body.id}`);
    expect(removed.status).toBe(200);
    expect(await prisma.courierDepot.count({ where: { id: added.body.id } })).toBe(0);
  });

  it('refuses a duplicate depot name on the same courier', async () => {
    const courier = await makeCourier();
    await as(admin).post(`/api/couriers/${courier.id}/depots`).send({ name: 'Hub A' });
    const again = await as(admin).post(`/api/couriers/${courier.id}/depots`).send({ name: 'Hub A' });
    expect(again.status).toBe(400);
  });
});
