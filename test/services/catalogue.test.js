/**
 * The service catalogue and the per-client rates hung off it.
 *
 * The price book is admin-only throughout: an employee who could read every
 * client's negotiated rate would be reading the company's commercial position,
 * and one who could edit it could bill a client anything. The one exception is
 * a client reading their own agreed rates.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import {
  makeAdmin,
  makeClient,
  makeEmployee,
  makeService,
  makeClientService,
} from '../factories/index.js';

describe('the service catalogue', () => {
  it('creates a service', async () => {
    const admin = await makeAdmin();

    const res = await as(admin)
      .post('/api/services')
      .send({ description: 'Pallet wrapping', ideaPrice: '4.25', unit: 'pallet' });

    expect(res.status).toBe(201);
    expect(await prisma.service.count()).toBe(1);
  });

  it('is closed to employees', async () => {
    const { user: employeeUser } = await makeEmployee();

    expect((await as(employeeUser).get('/api/services')).status).toBe(403);
    expect(
      (await as(employeeUser).post('/api/services').send({ description: 'x' })).status
    ).toBe(403);
  });

  it('is closed to clients', async () => {
    const { user: clientUser } = await makeClient();
    expect((await as(clientUser).get('/api/services')).status).toBe(403);
  });

  it('refuses anonymous requests', async () => {
    expect((await anon().get('/api/services')).status).toBe(401);
  });

  it('updates a service', async () => {
    const admin = await makeAdmin();
    const service = await makeService();

    const res = await as(admin)
      .put(`/api/services/${service.id}`)
      .send({ description: 'Renamed' });

    expect(res.status).toBe(200);
    const after = await prisma.service.findUnique({ where: { id: service.id } });
    expect(after.description).toBe('Renamed');
  });
});

describe('agreed rates', () => {
  it('are recorded per client', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const service = await makeService();

    const res = await as(admin).post('/api/client-services').send({
      clientId: client.id,
      serviceId: service.id,
      chargedPrice: '7.50',
      unit: 'item',
    });

    expect(res.status).toBe(201);
  });

  it('are unique per client and service', async () => {
    // @@unique(clientId, serviceId). Two rates for one pair is what made the
    // singular finder return an array in the first place.
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const service = await makeService();
    await makeClientService(client.id, service.id);

    const res = await as(admin).post('/api/client-services').send({
      clientId: client.id,
      serviceId: service.id,
      chargedPrice: '9.99',
      unit: 'item',
    });

    expect(res.status).toBe(400);
    expect(
      await prisma.clientService.count({
        where: { clientId: client.id, serviceId: service.id },
      })
    ).toBe(1);
  });

  it('let a client see their own', async () => {
    const admin = await makeAdmin();
    void admin;
    const { client, user: clientUser } = await makeClient();
    const service = await makeService();
    await makeClientService(client.id, service.id);

    const res = await as(clientUser).get(`/api/client-services/client/${client.id}`);

    expect(res.status).toBe(200);
  });

  it('are not readable in bulk by an employee', async () => {
    // The whole price book is the company's commercial position.
    const { user: employeeUser } = await makeEmployee();
    expect((await as(employeeUser).get('/api/client-services')).status).toBe(403);
  });

  it('are not editable by an employee', async () => {
    const { user: employeeUser } = await makeEmployee();
    const { client } = await makeClient();
    const service = await makeService();

    const res = await as(employeeUser).post('/api/client-services').send({
      clientId: client.id,
      serviceId: service.id,
      chargedPrice: '0.01',
      unit: 'item',
    });

    expect(res.status).toBe(403);
  });
});
