/**
 * Charging a quantity of a service to a client.
 *
 * Two shapes, because there are two real needs and they behave differently.
 *
 * A standing monthly charge — storage, a retainer — is a rate marked recurring
 * with a quantity, raised every period whether or not anything shipped. That is
 * how a client who ships through someone else gets billed at all.
 *
 * A one-off is work that happened once and is not tied to a shipment: an hour of
 * re-labelling, a pallet rewrapped. It goes onto whichever period is open.
 *
 * Both bill only at a rate the client has already agreed. Inventing a price at
 * the point of charging is how somebody gets billed something nobody agreed to.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeService,
  makeClientService,
  makeRecurringService,
} from '../factories/index.js';

const invoiceFor = (clientId) =>
  prisma.monthlyInvoice.findFirst({
    where: { clientId },
    include: { lineItems: true },
  });

const arrange = async () => {
  const scenario = await makeWarehouseScenario();
  const service = await makeService({ description: 'Re-labelling', unit: 'hour' });
  const rate = await makeClientService(scenario.client.id, service.id, {
    chargedPrice: '15.00',
    unit: 'hour',
  });
  return { ...scenario, service, rate };
};

describe('a one-off service charge', () => {
  it('lands on the open invoice at the agreed rate', async () => {
    const ctx = await arrange();

    const res = await as(ctx.admin).post('/api/monthly-invoices/charge-service').send({
      clientId: ctx.client.id,
      clientServiceId: ctx.rate.id,
      quantity: 3,
    });

    expect(res.status).toBe(201);
    const invoice = await invoiceFor(ctx.client.id);
    expect(invoice.lineItems).toHaveLength(1);
    expect(Number(invoice.lineItems[0].totalPrice)).toBe(45); // 3 x 15.00
    expect(Number(invoice.totalAmount)).toBe(45);
  });

  it('opens an invoice for a client who has never shipped anything', async () => {
    // The services-only client, billed with no shipment in sight.
    const ctx = await arrange();
    expect(await prisma.monthlyInvoice.count()).toBe(0);

    await as(ctx.admin).post('/api/monthly-invoices/charge-service').send({
      clientId: ctx.client.id,
      clientServiceId: ctx.rate.id,
      quantity: 1,
    });

    expect(await prisma.monthlyInvoice.count()).toBe(1);
  });

  it('accumulates onto one invoice rather than opening several', async () => {
    const ctx = await arrange();

    await as(ctx.admin).post('/api/monthly-invoices/charge-service').send({
      clientId: ctx.client.id, clientServiceId: ctx.rate.id, quantity: 2,
    });
    await as(ctx.admin).post('/api/monthly-invoices/charge-service').send({
      clientId: ctx.client.id, clientServiceId: ctx.rate.id, quantity: 1,
    });

    const invoices = await prisma.monthlyInvoice.findMany({ include: { lineItems: true } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].lineItems).toHaveLength(2);
    expect(Number(invoices[0].totalAmount)).toBe(45); // 30 + 15
  });

  it('describes itself, so an invoice reader knows what it was for', async () => {
    const ctx = await arrange();

    await as(ctx.admin).post('/api/monthly-invoices/charge-service').send({
      clientId: ctx.client.id, clientServiceId: ctx.rate.id, quantity: 2,
    });

    const invoice = await invoiceFor(ctx.client.id);
    expect(invoice.lineItems[0].description).toContain('Re-labelling');
  });

  it('accepts a custom description', async () => {
    const ctx = await arrange();

    await as(ctx.admin).post('/api/monthly-invoices/charge-service').send({
      clientId: ctx.client.id,
      clientServiceId: ctx.rate.id,
      quantity: 1,
      description: 'Emergency relabel, Saturday call-out',
    });

    const invoice = await invoiceFor(ctx.client.id);
    expect(invoice.lineItems[0].description).toBe('Emergency relabel, Saturday call-out');
  });

  it('refuses a rate belonging to another client', async () => {
    // Otherwise one client's negotiated price ends up on another's invoice.
    const ctx = await arrange();
    const other = await makeWarehouseScenario();

    const res = await as(ctx.admin).post('/api/monthly-invoices/charge-service').send({
      clientId: other.client.id,
      clientServiceId: ctx.rate.id,
      quantity: 1,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different client/i);
    expect(await prisma.invoiceLineItem.count()).toBe(0);
  });

  it('refuses a rate that does not exist', async () => {
    const ctx = await arrange();

    const res = await as(ctx.admin).post('/api/monthly-invoices/charge-service').send({
      clientId: ctx.client.id,
      clientServiceId: '00000000-0000-0000-0000-000000000000',
      quantity: 1,
    });

    expect(res.status).toBe(400);
  });

  it('refuses zero and negative quantities', async () => {
    const ctx = await arrange();

    for (const quantity of [0, -2]) {
      const res = await as(ctx.admin).post('/api/monthly-invoices/charge-service').send({
        clientId: ctx.client.id, clientServiceId: ctx.rate.id, quantity,
      });
      expect(res.status).toBe(400);
    }
    expect(await prisma.invoiceLineItem.count()).toBe(0);
  });

  it('is admin only', async () => {
    const ctx = await arrange();

    const res = await as(ctx.employeeUser).post('/api/monthly-invoices/charge-service').send({
      clientId: ctx.client.id, clientServiceId: ctx.rate.id, quantity: 1,
    });

    expect(res.status).toBe(403);
  });

  it('is not reachable by a client charging themselves', async () => {
    const ctx = await arrange();

    const res = await as(ctx.clientUser).post('/api/monthly-invoices/charge-service').send({
      clientId: ctx.client.id, clientServiceId: ctx.rate.id, quantity: 1,
    });

    expect(res.status).toBe(403);
  });
});

describe('marking a rate as a standing monthly charge', () => {
  it('sets the recurring flag and quantity', async () => {
    const ctx = await arrange();

    const res = await as(ctx.admin)
      .put(`/api/client-services/${ctx.rate.id}`)
      .send({ isRecurring: true, recurringQuantity: 4 });

    expect(res.status).toBe(200);
    const after = await prisma.clientService.findUnique({ where: { id: ctx.rate.id } });
    expect(after.isRecurring).toBe(true);
    expect(Number(after.recurringQuantity)).toBe(4);
  });

  it('defaults the quantity to 1 rather than billing nothing every month', async () => {
    // A standing charge with no quantity would raise a zero line forever and
    // look like it was working.
    const ctx = await arrange();

    await as(ctx.admin)
      .put(`/api/client-services/${ctx.rate.id}`)
      .send({ isRecurring: true });

    const after = await prisma.clientService.findUnique({ where: { id: ctx.rate.id } });
    expect(Number(after.recurringQuantity)).toBeGreaterThan(0);
  });

  it('refuses a zero or negative recurring quantity', async () => {
    const ctx = await arrange();

    const res = await as(ctx.admin)
      .put(`/api/client-services/${ctx.rate.id}`)
      .send({ isRecurring: true, recurringQuantity: 0 });

    expect(res.status).toBe(400);
  });

  it('will not let the update move a rate to another client', async () => {
    // clientId and serviceId are the unique pair; rewriting them would silently
    // reprice somebody else's invoices.
    const ctx = await arrange();
    const other = await makeWarehouseScenario();

    await as(ctx.admin)
      .put(`/api/client-services/${ctx.rate.id}`)
      .send({ chargedPrice: '20.00', clientId: other.client.id });

    const after = await prisma.clientService.findUnique({ where: { id: ctx.rate.id } });
    expect(after.clientId).toBe(ctx.client.id);
    expect(Number(after.chargedPrice)).toBe(20);
  });

  it('refuses a negative price', async () => {
    const ctx = await arrange();

    const res = await as(ctx.admin)
      .put(`/api/client-services/${ctx.rate.id}`)
      .send({ chargedPrice: '-5.00' });

    expect(res.status).toBe(400);
  });

  it('bills the standing quantity on the next period, with no shipment', async () => {
    const ctx = await arrange();
    await makeRecurringService(ctx.client.id, {
      chargedPrice: '25.00',
      recurringQuantity: '4',
    });

    // Any charge opens the period, which is when standing charges are applied.
    await as(ctx.admin).post('/api/monthly-invoices/charge-service').send({
      clientId: ctx.client.id, clientServiceId: ctx.rate.id, quantity: 1,
    });

    const invoice = await invoiceFor(ctx.client.id);
    const recurring = invoice.lineItems.find((l) => l.itemType === 'RECURRING_SERVICE');
    expect(recurring).toBeTruthy();
    expect(Number(recurring.totalPrice)).toBe(100); // 4 x 25.00
  });
});
