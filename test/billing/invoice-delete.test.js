/**
 * Deleting a draft invoice.
 *
 * What must hold:
 *   - A draft carrying a charge for a shipment, bulk shipment or return is not
 *     deleted: nothing would raise that charge again. The warning lists each
 *     kind before anything is pressed, and the delete answers 409 with it.
 *   - Once those lines are gone, the draft can be deleted, and any other lines
 *     (manual charges) go with it — the warning says so beforehand.
 *   - Approved and paid invoices stay undeletable, as before.
 *   - Admin-only, like the delete.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeClient,
  makeEmployee,
  makeInvoice,
  makeInvoiceLineItem,
  makeProduct,
  makeShipment,
} from '../factories/index.js';

/** A client's draft with one manual line and one charge for a shipment. */
const arrange = async () => {
  const admin = await makeAdmin();
  const { client } = await makeClient();
  const { employee } = await makeEmployee();
  const shipment = await makeShipment(employee.id, client.id, { status: 'DISPATCHED' });
  const invoice = await makeInvoice(client.id);
  await makeInvoiceLineItem(invoice.id, { description: 'Pallet handling' });
  const charge = await makeInvoiceLineItem(invoice.id, {
    itemType: 'SHIPMENT_CHARGE',
    description: `Dispatch — ${shipment.reference}`,
    shipmentId: shipment.id,
  });
  return { admin, client, invoice, shipment, charge };
};

const invoiceExists = async (id) => (await prisma.monthlyInvoice.count({ where: { id } })) === 1;

describe('a draft carrying a shipment charge', () => {
  it('is reported as blocked before anything is pressed', async () => {
    const { admin, invoice } = await arrange();

    const res = await as(admin).get(`/api/monthly-invoices/${invoice.id}/dependents`);

    expect(res.status).toBe(200);
    expect(res.body.canDelete).toBe(false);
    expect(res.body.blocking).toEqual([
      expect.objectContaining({ key: 'shipmentCharges', count: 1, where: '/shipments' }),
    ]);
    expect(res.body.removedWith).toEqual([expect.objectContaining({ key: 'otherCharges', count: 1 })]);
  });

  it('is refused with the same report', async () => {
    const { admin, invoice } = await arrange();

    const res = await as(admin).delete(`/api/monthly-invoices/${invoice.id}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HAS_DEPENDENTS');
    expect(res.body.dependents.blocking[0].key).toBe('shipmentCharges');
    expect(await invoiceExists(invoice.id)).toBe(true);
  });

  it('can be deleted once the charge is removed, its manual lines going with it', async () => {
    const { admin, invoice, charge } = await arrange();
    await as(admin).delete(`/api/monthly-invoices/${invoice.id}/line-items/${charge.id}`);

    const res = await as(admin).delete(`/api/monthly-invoices/${invoice.id}`);

    expect(res.status).toBe(200);
    expect(await invoiceExists(invoice.id)).toBe(false);
    expect(await prisma.invoiceLineItem.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });
});

describe('return and bulk shipment charges', () => {
  it('block the delete too, each counted once', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const { employee } = await makeEmployee();
    const product = await makeProduct(client.id);
    const shipment = await makeShipment(employee.id, client.id, { status: 'DISPATCHED' });
    const productReturn = await prisma.productReturn.create({
      data: { reference: 'RET-TEST-1', clientId: client.id, productId: product.id, quantity: 1 },
    });
    const category = await prisma.fbaCategory.create({ data: { name: 'Invoice delete test' } });
    const bulk = await prisma.fbaShipment.create({
      data: { reference: 'BULK-TEST-1', clientId: client.id, categoryId: category.id },
    });
    const invoice = await makeInvoice(client.id);
    // A return's charge can also name its shipment; it counts as a return charge.
    await makeInvoiceLineItem(invoice.id, { returnId: productReturn.id, shipmentId: shipment.id });
    await makeInvoiceLineItem(invoice.id, { itemType: 'FBA_CHARGE', fbaShipmentId: bulk.id });
    await makeInvoiceLineItem(invoice.id, { itemType: 'SHIPMENT_CHARGE', shipmentId: shipment.id });

    const res = await as(admin).get(`/api/monthly-invoices/${invoice.id}/dependents`);

    const counts = Object.fromEntries(res.body.blocking.map((row) => [row.key, row.count]));
    expect(counts).toEqual({ shipmentCharges: 1, bulkShipmentCharges: 1, returnCharges: 1 });
    expect(res.body.removedWith).toEqual([]);
  });
});

describe('a draft with only manual lines', () => {
  it('can be deleted straight away', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const invoice = await makeInvoice(client.id);
    await makeInvoiceLineItem(invoice.id);

    const report = await as(admin).get(`/api/monthly-invoices/${invoice.id}/dependents`);
    expect(report.body.canDelete).toBe(true);

    expect((await as(admin).delete(`/api/monthly-invoices/${invoice.id}`)).status).toBe(200);
  });
});

describe('an invoice that does not exist', () => {
  it('answers 404', async () => {
    const admin = await makeAdmin();
    const missing = '00000000-0000-4000-8000-000000000000';

    expect((await as(admin).get(`/api/monthly-invoices/${missing}/dependents`)).status).toBe(404);
    expect((await as(admin).delete(`/api/monthly-invoices/${missing}`)).status).toBe(404);
  });
});

describe('who may see the warning', () => {
  it('is admins only, like the delete', async () => {
    const { invoice } = await arrange();
    const { user } = await makeEmployee();

    expect((await as(user).get(`/api/monthly-invoices/${invoice.id}/dependents`)).status).toBe(403);
  });
});
