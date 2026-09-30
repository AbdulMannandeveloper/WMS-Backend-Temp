/**
 * Booking, editing, dispatching and removing a freight shipment.
 *
 * The acceptance criteria for the Pakistan half of the module. The parts that
 * matter most here are the ones a caller could otherwise talk the API out of: the
 * reference and barcode are issued by the server and cannot be named in a body,
 * they survive an edit, and a received shipment's record cannot be deleted.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeFreightShipment,
  grantPermissions,
} from '../factories/index.js';

let admin;
let staff;

beforeEach(async () => {
  admin = await makeAdmin();
  const { user } = await makeEmployee();
  staff = user;
  // Granted before this user's first request: authorizeRoles caches the row.
  await grantPermissions(staff, [
    'freight:create',
    'freight:read',
    'freight:update',
    'freight:delete',
  ]);
});

const booking = (overrides = {}) => ({
  senderName: 'Ali Khan',
  senderContact: '+92 300 1234567',
  senderAddress: '12 Mall Road, Lahore',
  receiverName: 'XYZ Trading',
  receiverContact: '+44 7700 900123',
  receiverAddress: '4 Dock Street, London',
  destinationCountry: 'United Kingdom',
  description: 'Two boxes of textiles',
  quantity: 2,
  weight: '8.5',
  weightUnit: 'KG',
  ...overrides,
});

const create = (actor = admin, body = booking()) =>
  as(actor).post('/api/freight-shipments').send(body);

describe('booking a freight shipment', () => {
  it('opens a BOOKED shipment with a server-issued FRT reference and a matching barcode', async () => {
    const res = await create();

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('BOOKED');
    expect(res.body.reference).toMatch(/^FRT-\d{4}-\d{6}$/);
    // The label carries the reference — the whole traceability chain depends on
    // the two agreeing.
    expect(res.body.barcode).toBe(res.body.reference);
    expect(res.body.senderName).toBe('Ali Khan');
    expect(res.body.createdByName).toBe('Ada Admin');
    expect(res.body.dispatchedAt).toBeNull();
  });

  it('numbers consecutive bookings in sequence', async () => {
    const first = await create();
    const second = await create();

    const tail = (reference) => Number.parseInt(reference.slice(-6), 10);
    expect(tail(second.body.reference)).toBe(tail(first.body.reference) + 1);
  });

  it('ignores a reference, barcode or status named in the body', async () => {
    const res = await create(admin, {
      ...booking(),
      reference: 'FRT-1999-000001',
      barcode: 'HAND-WRITTEN',
      status: 'RECEIVED',
    });

    expect(res.status).toBe(201);
    expect(res.body.reference).not.toBe('FRT-1999-000001');
    expect(res.body.barcode).not.toBe('HAND-WRITTEN');
    expect(res.body.status).toBe('BOOKED');
  });

  it('refuses an invalid quantity or weight', async () => {
    for (const quantity of [0, -1, 2.5, 'two']) {
      const res = await create(admin, booking({ quantity }));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/quantity/i);
    }

    for (const weight of [0, -1, 'heavy']) {
      const res = await create(admin, booking({ weight }));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/weight/i);
    }
  });

  it('refuses a booking missing required information, naming the field', async () => {
    const res = await create(admin, booking({ senderName: '   ' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sender's name is required/i);

    const noReceiver = await create(admin, booking({ receiverAddress: undefined }));
    expect(noReceiver.status).toBe(400);
    expect(noReceiver.body.error).toMatch(/receiver's address is required/i);
  });

  it('refuses a contact number that is not one, and keeps one that is as typed', async () => {
    const bad = await create(admin, booking({ senderContact: 'ring the shop' }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/contact number/i);

    const good = await create(admin, booking({ senderContact: '(042) 111-222 333' }));
    expect(good.status).toBe(201);
    expect(good.body.senderContact).toBe('(042) 111-222 333');
  });

  it('rejects a weight unit outside KG and LB, and defaults to KG', async () => {
    const bad = await create(admin, booking({ weightUnit: 'STONE' }));
    expect(bad.status).toBe(400);

    const defaulted = await create(admin, booking({ weightUnit: undefined }));
    expect(defaulted.body.weightUnit).toBe('KG');
  });

  it('keeps every digit of a weight weighed to the gram', async () => {
    const res = await create(admin, booking({ weight: '8.456' }));
    expect(res.status).toBe(201);
    expect(String(res.body.weight)).toBe('8.456');
  });

  it('is open to an employee holding freight:create, and needs a session', async () => {
    expect((await create(staff)).status).toBe(201);
    expect((await anon().post('/api/freight-shipments').send(booking())).status).toBe(401);
  });
});

describe('editing a freight shipment', () => {
  it('preserves the reference and the barcode', async () => {
    const created = (await create()).body;

    const res = await as(admin)
      .put(`/api/freight-shipments/${created.id}`)
      .send({ receiverName: 'ABC Imports', remarks: 'Fragile' });

    expect(res.status).toBe(200);
    expect(res.body.receiverName).toBe('ABC Imports');
    expect(res.body.remarks).toBe('Fragile');
    expect(res.body.reference).toBe(created.reference);
    expect(res.body.barcode).toBe(created.barcode);
  });

  it('records who made the change and when', async () => {
    const created = (await create()).body;

    const res = await as(staff)
      .put(`/api/freight-shipments/${created.id}`)
      .send({ remarks: 'Repacked' });

    expect(res.body.updatedByName).toBe('Eli Employee');
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.createdAt).getTime(),
    );
  });

  it('cannot smuggle a status change through the edit', async () => {
    const created = (await create()).body;

    const res = await as(admin)
      .put(`/api/freight-shipments/${created.id}`)
      .send({ status: 'DISPATCHED' });

    // Nothing in the allowlist survived, so there is nothing to update.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nothing to update/i);

    const unchanged = await as(admin).get(`/api/freight-shipments/${created.id}`);
    expect(unchanged.body.status).toBe('BOOKED');
  });

  it('freezes the matched fields once received, and leaves the rest editable', async () => {
    const shipment = await makeFreightShipment({ status: 'RECEIVED' });
    await prisma.freightReceivingRecord.create({
      data: { freightShipmentId: shipment.id, barcode: shipment.barcode },
    });

    const frozen = await as(admin)
      .put(`/api/freight-shipments/${shipment.id}`)
      .send({ weight: '9.2' });
    expect(frozen.status).toBe(400);
    expect(frozen.body.error).toMatch(/already been received/i);

    const allowed = await as(admin)
      .put(`/api/freight-shipments/${shipment.id}`)
      .send({ receiverContact: '+44 7700 900999' });
    expect(allowed.status).toBe(200);
  });

  it('refuses to edit a cancelled shipment', async () => {
    const shipment = await makeFreightShipment({ status: 'CANCELLED' });
    const res = await as(admin)
      .put(`/api/freight-shipments/${shipment.id}`)
      .send({ remarks: 'Never mind' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cancelled/i);
  });

  it('answers 404 for a shipment that does not exist', async () => {
    const res = await as(admin)
      .put('/api/freight-shipments/11111111-1111-1111-1111-111111111111')
      .send({ remarks: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('dispatching', () => {
  it('moves BOOKED to DISPATCHED and records who and when', async () => {
    const created = (await create()).body;

    const res = await as(staff).post(`/api/freight-shipments/${created.id}/dispatch`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISPATCHED');
    expect(res.body.dispatchedByName).toBe('Eli Employee');
    expect(res.body.dispatchedAt).not.toBeNull();
  });

  it('refuses a second dispatch', async () => {
    const created = (await create()).body;
    await as(admin).post(`/api/freight-shipments/${created.id}/dispatch`);

    const again = await as(admin).post(`/api/freight-shipments/${created.id}/dispatch`);
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/cannot become DISPATCHED/i);
  });

  it('refuses a shipment with a field missing, naming it', async () => {
    // Written directly: the API will not create one this incomplete, but a row
    // predating a required field can be.
    const shipment = await makeFreightShipment({ destinationCountry: '' });

    const res = await as(admin).post(`/api/freight-shipments/${shipment.id}/dispatch`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/destination country/i);
  });

  it('refuses to dispatch a cancelled shipment', async () => {
    const shipment = await makeFreightShipment({ status: 'CANCELLED' });
    const res = await as(admin).post(`/api/freight-shipments/${shipment.id}/dispatch`);
    expect(res.status).toBe(400);
  });
});

describe('cancelling and deleting', () => {
  it('cancels a booked shipment and keeps the record readable', async () => {
    const created = (await create()).body;

    const res = await as(admin).post(`/api/freight-shipments/${created.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.cancelledByName).toBe('Ada Admin');

    const stillThere = await as(admin).get(`/api/freight-shipments/${created.id}`);
    expect(stillThere.status).toBe(200);
  });

  it('deletes a mis-keyed booking outright', async () => {
    const created = (await create()).body;

    const res = await as(admin).delete(`/api/freight-shipments/${created.id}`);
    expect(res.status).toBe(200);

    expect(
      await prisma.freightShipment.findUnique({ where: { id: created.id } }),
    ).toBeNull();
  });

  it('refuses to delete a shipment that was received, and says to cancel instead', async () => {
    const shipment = await makeFreightShipment({ status: 'RECEIVED' });
    await prisma.freightReceivingRecord.create({
      data: { freightShipmentId: shipment.id, barcode: shipment.barcode },
    });

    const res = await as(admin).delete(`/api/freight-shipments/${shipment.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cancel it instead/i);

    expect(
      await prisma.freightShipment.findUnique({ where: { id: shipment.id } }),
    ).not.toBeNull();
  });
});

describe('the shipment list', () => {
  beforeEach(async () => {
    await makeFreightShipment({
      senderName: 'Ali Khan',
      receiverName: 'XYZ Trading',
      destinationCountry: 'United Kingdom',
      status: 'BOOKED',
      weight: '8.500',
    });
    await makeFreightShipment({
      senderName: 'Bilal Ahmed',
      receiverName: 'Northern Depot',
      destinationCountry: 'United Kingdom',
      status: 'DISPATCHED',
      weight: '2.000',
    });
    await makeFreightShipment({
      senderName: 'Sana Raza',
      receiverName: 'XYZ Trading',
      destinationCountry: 'Ireland',
      status: 'RECEIVED',
      weight: '15.250',
    });
  });

  it('answers a paginated envelope', async () => {
    const res = await as(admin).get('/api/freight-shipments?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 2, total: 3, hasMore: true });
  });

  it('searches by shipment id, barcode, sender and receiver', async () => {
    const all = await as(admin).get('/api/freight-shipments');
    const target = all.body.data.find((row) => row.senderName === 'Ali Khan');

    const byReference = await as(admin).get(
      `/api/freight-shipments?search=${target.reference}`,
    );
    expect(byReference.body.data).toHaveLength(1);

    const byBarcode = await as(admin).get(`/api/freight-shipments?search=${target.barcode}`);
    expect(byBarcode.body.data).toHaveLength(1);

    const bySender = await as(admin).get('/api/freight-shipments?search=bilal');
    expect(bySender.body.data.map((r) => r.senderName)).toEqual(['Bilal Ahmed']);

    const byReceiver = await as(admin).get('/api/freight-shipments?search=XYZ');
    expect(byReceiver.body.data).toHaveLength(2);
  });

  it('filters by status and destination', async () => {
    const dispatched = await as(admin).get('/api/freight-shipments?status=DISPATCHED');
    expect(dispatched.body.data).toHaveLength(1);

    const ireland = await as(admin).get('/api/freight-shipments?destinationCountry=ireland');
    expect(ireland.body.data).toHaveLength(1);

    const bad = await as(admin).get('/api/freight-shipments?status=LOST');
    expect(bad.status).toBe(400);
  });

  it('sorts by the columns the table offers, and refuses one it does not', async () => {
    const byWeight = await as(admin).get(
      '/api/freight-shipments?sortBy=weight&sortOrder=desc',
    );
    expect(byWeight.body.data.map((r) => String(r.weight))).toEqual([
      '15.25',
      '8.5',
      '2',
    ]);

    const bySender = await as(admin).get(
      '/api/freight-shipments?sortBy=senderName&sortOrder=asc',
    );
    expect(bySender.body.data[0].senderName).toBe('Ali Khan');

    expect((await as(admin).get('/api/freight-shipments?sortBy=remarks')).status).toBe(400);
  });

  it('summarises the same rows the list shows', async () => {
    const summary = await as(admin).get('/api/freight-shipments/summary?status=RECEIVED');

    expect(summary.status).toBe(200);
    expect(summary.body.total).toBe(1);
    expect(summary.body.byStatus).toEqual([
      { status: 'RECEIVED', _count: { _all: 1 } },
    ]);
  });
});

describe('the audit trail', () => {
  it('names who created and dispatched the shipment, newest first', async () => {
    const created = (await create()).body;
    await as(staff).post(`/api/freight-shipments/${created.id}/dispatch`);

    const res = await as(admin).get(`/api/freight-shipments/${created.id}/history`);

    expect(res.status).toBe(200);
    expect(res.body.map((entry) => entry.action)).toEqual([
      'FREIGHT_SHIPMENT_DISPATCHED',
      'FREIGHT_SHIPMENT_CREATED',
    ]);
    expect(res.body[0].userName).toBe('Eli Employee');
    expect(res.body[1].userName).toBe('Ada Admin');
  });
});
