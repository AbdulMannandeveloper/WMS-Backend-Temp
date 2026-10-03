/**
 * References and tracking numbers keyed in by hand, in whatever case.
 *
 * Each of these used to be an exact match, so `shp-2026-000123` typed at the
 * bench found nothing while `SHP-2026-000123` did:
 *
 *   - a manual CHECKOUT naming the shipment it went out on
 *   - the ledger's reference filter
 *   - a return matched to the shipment by its courier tracking number
 *   - a freight parcel looked up by a code read off a scuffed label
 *
 * Unique system codes are looked up exactly first and only then ignoring case,
 * so dispatch and the scanner keep their indexed lookup.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeShipment,
  makeLedgerEntry,
  makeFreightShipment,
  makeAdmin,
  makeClient,
  makeProduct,
} from '../factories/index.js';

describe('a manual CHECKOUT', () => {
  /**
   * A warehouse with units already reserved: CHECKOUT takes stock out of the
   * reserved quantity (checkoutStockAtomically), so with none reserved it is
   * refused for want of stock before the reference matters.
   */
  const arrange = async () => {
    const scenario = await makeWarehouseScenario();
    await prisma.stockLevel.update({
      where: { id: scenario.stock.id },
      data: { reservedQuantity: 5 },
    });
    return scenario;
  };

  const checkout = (s, referenceId) =>
    as(s.admin).post('/api/inventory-ledgers').send({
      productId: s.product.id,
      movementType: 'CHECKOUT',
      quantity: 1,
      fromLocationId: s.location.id,
      referenceId,
    });

  it('finds the shipment from a reference typed in lower case', async () => {
    const s = await arrange();
    const shipment = await makeShipment(s.employee.id, s.client.id, { status: 'DISPATCHED' });

    const res = await checkout(s, `  ${shipment.reference.toLowerCase()} `);

    expect(res.status).toBe(201);
  });

  it('stores the reference as the shipment spells it', async () => {
    // Otherwise filtering the ledger by the reference would miss this movement
    // while finding the ones dispatch wrote.
    const s = await arrange();
    const shipment = await makeShipment(s.employee.id, s.client.id, { status: 'DISPATCHED' });

    const res = await checkout(s, shipment.reference.toLowerCase());

    const row = await prisma.inventoryLedger.findUnique({ where: { id: res.body.id } });
    expect(row.referenceId).toBe(shipment.reference);
  });

  it('finds a hand-written reference in its original case from an upper-case entry', async () => {
    // References written before the generators existed are in whatever case
    // they were typed, which is why the input is not simply uppercased.
    const s = await arrange();
    await makeShipment(s.employee.id, s.client.id, {
      status: 'DISPATCHED',
      reference: 'legacy-order-17',
    });

    const res = await checkout(s, 'LEGACY-ORDER-17');

    expect(res.status).toBe(201);
  });

  it('still refuses a reference that matches nothing', async () => {
    const s = await makeWarehouseScenario();

    const res = await checkout(s, 'shp-1999-000001');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/shipment not found/i);
  });
});

describe('filtering the ledger by reference', () => {
  it('ignores case, and treats _ as itself', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id);
    await makeLedgerEntry(product.id, admin.id, { referenceId: 'PO_7' });
    await makeLedgerEntry(product.id, admin.id, { referenceId: 'POX7' });

    const res = await as(admin).get('/api/inventory-ledgers?referenceId=po_7');

    expect(res.status).toBe(200);
    expect(res.body.data.map((row) => row.referenceId)).toEqual(['PO_7']);
  });
});

describe('a return matched by tracking number', () => {
  it('links to the shipment when the number is typed in another case', async () => {
    const s = await makeWarehouseScenario();
    const created = await as(s.admin)
      .post('/api/shipments')
      .send({
        trackingId: 'RM987654321GB',
        shipmentItems: [
          { productId: s.product.id, sourceLocationId: s.location.id, quantity: 3 },
        ],
      });
    expect(created.status).toBe(201);

    const res = await as(s.admin).post('/api/returns').send({
      trackingNumber: 'rm 987 654 321 gb',
      productId: s.product.id,
      quantity: 1,
    });

    expect(res.status).toBe(201);
    expect(res.body.shipmentId).toBe(created.body.id);
  });

  it('identifies the parcel from a lower-case number before anything is recorded', async () => {
    const s = await makeWarehouseScenario();
    const created = await as(s.admin)
      .post('/api/shipments')
      .send({
        trackingId: 'H01AA0123456789',
        shipmentItems: [
          { productId: s.product.id, sourceLocationId: s.location.id, quantity: 2 },
        ],
      });

    const res = await as(s.admin).get('/api/returns/identify').query({ tracking: 'h01aa0123456789' });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(created.body.id);
  });
});

describe('a freight parcel looked up by hand', () => {
  const lookup = (actor, code) =>
    as(actor).get(`/api/freight-shipments/lookup/barcode/${encodeURIComponent(code)}`);

  it('finds the barcode keyed in lower case', async () => {
    const admin = await makeAdmin();
    const shipment = await makeFreightShipment({ status: 'DISPATCHED' });

    const res = await lookup(admin, shipment.barcode.toLowerCase());

    expect(res.status).toBe(200);
    expect(res.body.matchedOn).toBe('barcode');
    expect(res.body.shipment.id).toBe(shipment.id);
  });

  it('finds a hand-written code in its original case', async () => {
    const admin = await makeAdmin();
    const shipment = await makeFreightShipment({
      reference: 'frt-handwritten-3',
      barcode: 'frt-handwritten-3',
    });

    const res = await lookup(admin, 'FRT-HANDWRITTEN-3');

    expect(res.status).toBe(200);
    expect(res.body.shipment.id).toBe(shipment.id);
  });
});
