/**
 * Server-side paging and filtering on the invoice list.
 *
 * This is the first use of grand_total, the column Postgres computes as
 * total_amount + tax_amount. The invoices screen has always filtered and sorted
 * on that sum, and Prisma cannot order by an expression — so before the column
 * existed the filter could only have been applied after a page was read, which
 * would make the total printed under the table describe a different set of rows
 * from the ones in it.
 *
 * The other thing pinned here is searching by invoice id. id is a uuid column,
 * and ILIKE against uuid is a Postgres type error rather than a miss, so a
 * search term that is not a uuid must not reach that clause at all.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeClient,
  makeInvoice,
  utcDate,
} from '../factories/index.js';

const ids = (body) => body.data.map((row) => row.id);

/** An invoice with a known subtotal and tax, so grand_total is predictable. */
const invoiceWorth = async (clientId, { net, tax = 0, ...rest }) => {
  const invoice = await makeInvoice(clientId, rest);
  return await prisma.monthlyInvoice.update({
    where: { id: invoice.id },
    data: { totalAmount: net, taxAmount: tax },
  });
};

let admin;
let client;

beforeEach(async () => {
  admin = await makeAdmin();
  client = (await makeClient({ companyName: 'Acme Logistics' })).client;
});

describe('the envelope', () => {
  it('answers { data, pagination } with the defaults applied', async () => {
    for (let m = 1; m <= 3; m += 1) {
      await makeInvoice(client.id, { billingPeriod: utcDate(2026, m, 1) });
    }

    const res = await as(admin).get('/api/monthly-invoices');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination.total).toBe(3);
  });

  it('carries the grand total the database computed', async () => {
    await invoiceWorth(client.id, {
      net: '100.00',
      tax: '20.00',
      billingPeriod: utcDate(2026, 1, 1),
    });

    const res = await as(admin).get('/api/monthly-invoices');

    expect(Number(res.body.data[0].grandTotal)).toBe(120);
  });

  it('is newest billing period first', async () => {
    await makeInvoice(client.id, { billingPeriod: utcDate(2026, 1, 1) });
    await makeInvoice(client.id, { billingPeriod: utcDate(2026, 3, 1) });
    await makeInvoice(client.id, { billingPeriod: utcDate(2026, 2, 1) });

    const res = await as(admin).get('/api/monthly-invoices');

    expect(
      res.body.data.map((r) => r.billingPeriod.slice(0, 7)),
    ).toEqual(['2026-03', '2026-02', '2026-01']);
  });
});

describe('page boundaries', () => {
  beforeEach(async () => {
    for (let m = 1; m <= 7; m += 1) {
      await makeInvoice(client.id, { billingPeriod: utcDate(2026, m, 1) });
    }
  });

  it('walks every row exactly once across pages', async () => {
    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await as(admin).get(
        `/api/monthly-invoices?page=${page}&limit=3`,
      );
      seen.push(...ids(res.body));
    }

    expect(new Set(seen).size).toBe(7);
  });

  it('clamps a limit past the maximum', async () => {
    const res = await as(admin).get('/api/monthly-invoices?limit=9999');

    expect(res.body.pagination.limit).toBe(200);
  });
});

describe('filters', () => {
  let northwind;

  beforeEach(async () => {
    northwind = (await makeClient({ companyName: 'Northwind Freight' })).client;

    await invoiceWorth(client.id, {
      net: '100.00',
      tax: '20.00',
      billingPeriod: utcDate(2026, 1, 1),
    });
    await invoiceWorth(client.id, {
      net: '400.00',
      tax: '0.00',
      billingPeriod: utcDate(2026, 3, 1),
    });
    await invoiceWorth(northwind.id, {
      net: '50.00',
      tax: '10.00',
      billingPeriod: utcDate(2026, 5, 1),
    });
  });

  it('narrows by client', async () => {
    const res = await as(admin).get(
      `/api/monthly-invoices?clientId=${northwind.id}`,
    );

    expect(res.body.pagination.total).toBe(1);
  });

  it('searches the company and contact name', async () => {
    const res = await as(admin).get('/api/monthly-invoices?search=Northwind');

    expect(res.body.pagination.total).toBe(1);
  });

  it('finds an invoice by its id, and tolerates a search term that is not one', async () => {
    const [one] = await prisma.monthlyInvoice.findMany({ take: 1 });

    const byId = await as(admin).get(`/api/monthly-invoices?search=${one.id}`);
    expect(byId.body.pagination.total).toBe(1);
    expect(byId.body.data[0].id).toBe(one.id);

    // The clause must not be added for a non-uuid term: ILIKE against a uuid
    // column is a type error, not an empty result.
    const notAnId = await as(admin).get('/api/monthly-invoices?search=not-a-uuid-at-all');
    expect(notAnId.status).toBe(200);
  });

  it('narrows by billing period, over whole months', async () => {
    const res = await as(admin).get(
      '/api/monthly-invoices?startDate=2026-01&endDate=2026-03',
    );

    expect(res.body.pagination.total).toBe(2);
  });

  it('narrows by the grand total, which is the sum the screen shows', async () => {
    // 120 and 60 are grand totals; 100 and 50 are the subtotals. Filtering on
    // the stored totalAmount would pick different rows.
    const res = await as(admin).get(
      '/api/monthly-invoices?totalMin=100&totalMax=200',
    );

    expect(res.body.pagination.total).toBe(1);
    expect(Number(res.body.data[0].grandTotal)).toBe(120);
  });

  it('narrows by whether tax was applied', async () => {
    await prisma.monthlyInvoice.updateMany({
      where: { taxAmount: { gt: 0 } },
      data: { taxApplied: true },
    });

    const taxed = await as(admin).get('/api/monthly-invoices?taxApplied=true');
    expect(taxed.body.pagination.total).toBe(2);
  });

  it('counts what the filter matched, not what the table holds', async () => {
    const res = await as(admin).get(
      `/api/monthly-invoices?clientId=${client.id}&limit=1`,
    );

    expect(res.body.pagination.total).toBe(2);
    expect(res.body.pagination.totalPages).toBe(2);
  });

  it('refuses a status the enum does not have', async () => {
    const res = await as(admin).get('/api/monthly-invoices?status=SETTLED');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status must be one of/);
  });
});

describe('sorting', () => {
  beforeEach(async () => {
    await invoiceWorth(client.id, {
      net: '30.00',
      tax: '0.00',
      billingPeriod: utcDate(2026, 1, 1),
    });
    await invoiceWorth(client.id, {
      net: '10.00',
      tax: '0.00',
      billingPeriod: utcDate(2026, 2, 1),
    });
    await invoiceWorth(client.id, {
      net: '20.00',
      tax: '0.00',
      billingPeriod: utcDate(2026, 3, 1),
    });
  });

  it('sorts by grand total, which no expression could do', async () => {
    const res = await as(admin).get(
      '/api/monthly-invoices?sortBy=grandTotal&sortOrder=asc',
    );

    expect(res.body.data.map((r) => Number(r.grandTotal))).toEqual([10, 20, 30]);
  });

  it('refuses a column that is not on the list', async () => {
    const res = await as(admin).get('/api/monthly-invoices?sortBy=pdfLink');

    expect(res.status).toBe(400);
  });
});

describe('the summary', () => {
  beforeEach(async () => {
    await invoiceWorth(client.id, {
      net: '100.00',
      tax: '20.00',
      billingPeriod: utcDate(2026, 1, 1),
    });
    await invoiceWorth(client.id, {
      net: '200.00',
      tax: '40.00',
      billingPeriod: utcDate(2026, 2, 1),
    });
  });

  it('totals net, tax and grand across the whole filtered set', async () => {
    const res = await as(admin).get('/api/monthly-invoices/summary?limit=1');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(Number(res.body.totalNet)).toBe(300);
    expect(Number(res.body.totalTax)).toBe(60);
    expect(Number(res.body.totalGrand)).toBe(360);
  });

  it('adds net and tax to the grand, because the database derived it', async () => {
    const res = await as(admin).get('/api/monthly-invoices/summary');

    expect(Number(res.body.totalGrand)).toBe(
      Number(res.body.totalNet) + Number(res.body.totalTax),
    );
  });

  it('counts by status, and the counts add up to the total', async () => {
    const res = await as(admin).get('/api/monthly-invoices/summary');
    const { DRAFT, APPROVED, PAID } = res.body.byStatus;

    expect(DRAFT + APPROVED + PAID).toBe(res.body.total);
  });

  it('reports what is still owed, excluding what is paid', async () => {
    const [first] = await prisma.monthlyInvoice.findMany({ take: 1 });
    await prisma.monthlyInvoice.update({
      where: { id: first.id },
      data: { status: 'PAID', paidAt: new Date() },
    });

    const res = await as(admin).get('/api/monthly-invoices/summary');

    expect(Number(res.body.totalGrand)).toBe(360);
    expect(Number(res.body.outstandingGrand)).toBeLessThan(360);
  });

  it('agrees with the list it sits above', async () => {
    const list = await as(admin).get(
      `/api/monthly-invoices?clientId=${client.id}&limit=1`,
    );
    const summary = await as(admin).get(
      `/api/monthly-invoices/summary?clientId=${client.id}`,
    );

    expect(summary.body.total).toBe(list.body.pagination.total);
  });

  it('ignores paging and sorting entirely', async () => {
    const plain = await as(admin).get('/api/monthly-invoices/summary');
    const noisy = await as(admin).get(
      '/api/monthly-invoices/summary?page=3&limit=1&sortBy=grandTotal&sortOrder=asc',
    );

    expect(noisy.body).toEqual(plain.body);
  });

  it('resolves as itself rather than as an invoice with that id', async () => {
    // /summary is declared above "/:id", which would otherwise read it as a
    // lookup for an invoice whose id is the word summary.
    const res = await as(admin).get('/api/monthly-invoices/summary');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('byStatus');
  });
});

describe('one client cannot see another', () => {
  let other;

  beforeEach(async () => {
    other = await makeClient({ companyName: 'Other Co' });
    await makeInvoice(other.client.id, { billingPeriod: utcDate(2026, 1, 1) });
    await makeInvoice(client.id, { billingPeriod: utcDate(2026, 1, 1) });
  });

  it('does not expose the whole list to a client at all', async () => {
    // Unlike stock, this route is admin-only: a client reads its billing
    // through /client/:clientId below, where ownership of the path parameter
    // is checked. The clientId filter here is a staff convenience, and
    // resolveClientFilter guards it so that opening the route later is a
    // change to one line rather than a leak already sitting in the handler.
    const viewer = await makeClient({ companyName: 'Viewer Co' });
    await makeInvoice(viewer.client.id, { billingPeriod: utcDate(2026, 2, 1) });

    const list = await as(viewer.user).get('/api/monthly-invoices');
    const summary = await as(viewer.user).get('/api/monthly-invoices/summary');

    expect(list.status).toBe(403);
    expect(summary.status).toBe(403);
    expect(JSON.stringify(list.body)).not.toContain(other.client.id);
  });

  it('lets staff point clientId anywhere', async () => {
    const res = await as(admin).get(
      `/api/monthly-invoices?clientId=${other.client.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(1);
  });

  it('scopes a staff summary when clientId is given', async () => {
    const res = await as(admin).get(
      `/api/monthly-invoices/summary?clientId=${other.client.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('pages the client-scoped route and keeps its total honest', async () => {
    for (let m = 2; m <= 6; m += 1) {
      await makeInvoice(client.id, { billingPeriod: utcDate(2026, m, 1) });
    }

    const res = await as(admin).get(
      `/api/monthly-invoices/client/${client.id}?limit=2`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(6);
  });

  it('refuses one client reading another through the scoped route', async () => {
    const viewer = await makeClient();

    const res = await as(viewer.user).get(
      `/api/monthly-invoices/client/${other.client.id}`,
    );

    expect(res.status).toBe(403);
  });
});

describe('grand_total is the database having the last word', () => {
  it('follows a change to the subtotal without anyone writing it', async () => {
    const invoice = await invoiceWorth(client.id, {
      net: '100.00',
      tax: '20.00',
      billingPeriod: utcDate(2026, 7, 1),
    });
    expect(Number(invoice.grandTotal)).toBe(120);

    await prisma.monthlyInvoice.update({
      where: { id: invoice.id },
      data: { totalAmount: '500.00' },
    });

    const res = await as(admin).get(`/api/monthly-invoices/${invoice.id}`);

    // Nothing recalculated it. The column is GENERATED ALWAYS, so the sum
    // cannot lag the parts it is made of.
    expect(Number(res.body.grandTotal)).toBe(520);
  });
});

describe('authorisation', () => {
  it('keeps the list and the summary admin-only', async () => {
    const { user: employee } = await makeEmployee();

    expect((await as(employee).get('/api/monthly-invoices')).status).toBe(403);
    expect(
      (await as(employee).get('/api/monthly-invoices/summary')).status,
    ).toBe(403);
  });
});
