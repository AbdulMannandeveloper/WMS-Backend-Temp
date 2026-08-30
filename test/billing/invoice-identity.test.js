/**
 * Which company an invoice goes out as.
 *
 * Work carrying tax is billed by Nayoram Ltd, the VAT-registered entity;
 * everything else by Pro Packers UK, which is not. That one fact changes the
 * company name, phone, email, website, the bank account the client pays into,
 * the header colour and whether registration numbers appear.
 *
 * These tests exist because the failure mode is not a crash. A Nayoram invoice
 * carrying the Pro Packers account number looks entirely normal and sends a
 * client's money to the wrong place, and printing another entity's VAT number
 * under the wrong name is a misstatement on a tax document. So the pairs are
 * asserted together, and each rendering is checked for the *absence* of the
 * other entity's details.
 */

import { describe, it, expect } from 'vitest';

import invoicePdf from '../../utils/invoicePdf.js';
import invoiceIdentity from '../../utils/invoiceIdentity.js';

const { renderInvoicePdf } = invoicePdf;
const { identityFor, PRO_PACKERS, NAYORAM } = invoiceIdentity;

const invoiceFixture = (overrides = {}) => ({
  id: 'b2b4d0eb-7477-488d-8ca1-71de997032df',
  billingPeriod: new Date(Date.UTC(2026, 7, 1)),
  createdAt: new Date(),
  approvedAt: new Date(),
  status: 'APPROVED',
  client: {
    companyName: 'Stryde Consulting Ltd',
    contactName: 'A Client',
    email: 'client@example.test',
  },
  lineItems: [
    {
      description: 'Shipment dispatch',
      itemType: 'SHIPMENT_CHARGE',
      dateOfService: new Date(),
      quantity: 100,
      unitPrice: '2.00',
      totalPrice: '200.00',
    },
  ],
  totalAmount: '200.00',
  taxApplied: false,
  taxAmount: '0.00',
  taxRate: null,
  ...overrides,
});

const taxedFixture = () =>
  invoiceFixture({ taxApplied: true, taxRate: '20.00', taxAmount: '40.00' });

/**
 * jsPDF writes text as a compressed content stream, so the raw buffer does not
 * contain readable strings. Rendering with compression off makes the text
 * greppable, which is the only way to assert on what actually reaches the page.
 */
const renderedText = (invoice) => renderInvoicePdf(invoice).toString('latin1');

/**
 * A PDF content stream escapes parentheses, so "Tax (20%)" is written as
 * "Tax \(20%\)". Searching for the unescaped form silently finds nothing —
 * which makes a negative assertion pass for the wrong reason.
 */
const pdfLiteral = (text) =>
  text.replace(/\(/g, String.raw`\(`).replace(/\)/g, String.raw`\)`);

describe('choosing the entity', () => {
  it('is Pro Packers when no tax was charged', () => {
    expect(identityFor(invoiceFixture()).key).toBe('PRO_PACKERS');
  });

  it('is Nayoram when tax was charged', () => {
    expect(identityFor(taxedFixture()).key).toBe('NAYORAM');
  });

  it('is Pro Packers when the box is ticked but the tax is zero', () => {
    // A ticked box at a zero rate charges no VAT, so it is not a VAT invoice
    // and must not go out under the VAT-registered company.
    const invoice = invoiceFixture({
      taxApplied: true,
      taxRate: '0.00',
      taxAmount: '0.00',
    });
    expect(identityFor(invoice).key).toBe('PRO_PACKERS');
  });

  it('is Pro Packers for an invoice with no tax fields at all', () => {
    // Rows predating the tax columns.
    expect(identityFor({ id: 'x' }).key).toBe('PRO_PACKERS');
  });
});

describe('the two identities never share details', () => {
  it('use different bank accounts', () => {
    expect(PRO_PACKERS.bank.accountNumber).not.toBe(NAYORAM.bank.accountNumber);
    expect(PRO_PACKERS.bank.sortCode).not.toBe(NAYORAM.bank.sortCode);
  });

  it('use different header colours', () => {
    expect(PRO_PACKERS.headerColor).not.toEqual(NAYORAM.headerColor);
  });

  it('put registration numbers only on the VAT-registered one', () => {
    expect(PRO_PACKERS.registration).toBeNull();
    expect(PRO_PACKERS.vatRegistered).toBe(false);
    expect(NAYORAM.registration.vatNumber).toBe('505219714');
    expect(NAYORAM.registration.companyNumber).toBe('13376451');
  });

  it('trade from the same address', () => {
    expect(PRO_PACKERS.address.oneLine).toBe(NAYORAM.address.oneLine);
  });
});

describe('an untaxed invoice renders as Pro Packers', () => {
  it('names Pro Packers and not Nayoram', () => {
    const pdf = renderedText(invoiceFixture());
    expect(pdf).toContain('Pro Packers UK');
    expect(pdf).not.toContain('Nayoram');
  });

  it('carries the Pro Packers bank account and not the other', () => {
    // The assertion that matters most: the wrong number here sends a client's
    // payment to a different company.
    const pdf = renderedText(invoiceFixture());
    expect(pdf).toContain('21929729');
    expect(pdf).toContain('60-84-64');
    expect(pdf).not.toContain('17817110');
    expect(pdf).not.toContain('01-00-04');
  });

  it('shows no VAT or company registration number anywhere', () => {
    // Pro Packers is not VAT registered. Printing Nayoram's numbers under this
    // name would be a misstatement on a tax document.
    const pdf = renderedText(invoiceFixture());
    expect(pdf).not.toContain('505219714');
    expect(pdf).not.toContain('13376451');
    expect(pdf).not.toMatch(/VAT No/);
  });

  it('carries no tax row', () => {
    // Escaped, or this passes because it is looking for text no PDF ever holds.
    expect(renderedText(invoiceFixture())).not.toContain(pdfLiteral('Tax ('));
  });
});

describe('a taxed invoice renders as Nayoram', () => {
  it('names Nayoram and not Pro Packers', () => {
    const pdf = renderedText(taxedFixture());
    expect(pdf).toContain('Nayoram Ltd');
    expect(pdf).not.toContain('Pro Packers UK');
  });

  it('carries the Nayoram bank account and not the other', () => {
    const pdf = renderedText(taxedFixture());
    expect(pdf).toContain('17817110');
    expect(pdf).toContain('01-00-04');
    expect(pdf).not.toContain('21929729');
    expect(pdf).not.toContain('60-84-64');
  });

  it('carries both registration numbers', () => {
    const pdf = renderedText(taxedFixture());
    expect(pdf).toContain('13376451');
    expect(pdf).toContain('505219714');
  });

  it('carries the Nayoram contacts, not the Pro Packers ones', () => {
    const pdf = renderedText(taxedFixture());
    expect(pdf).toContain('support@nayoram.com');
    expect(pdf).not.toContain('support@propackers.uk');
  });

  it('shows a tax row and a total that reconciles', () => {
    const pdf = renderedText(taxedFixture());
    expect(pdf).toContain(pdfLiteral('Tax (20%)'));
    expect(pdf).toContain('40.00'); // the tax
    expect(pdf).toContain('240.00'); // 200.00 + 40.00
  });
});

describe('neither invoice carries a personal name', () => {
  it('omits it from the untaxed one', () => {
    // The supplied template carried one under the company name. It is not
    // wanted on either entity.
    const pdf = renderedText(invoiceFixture());
    expect(pdf).not.toMatch(/Ehtesham/i);
    expect(pdf).not.toMatch(/Shabbir/i);
    expect(pdf).not.toMatch(/Ehtisham/i);
  });

  it('omits it from the taxed one', () => {
    const pdf = renderedText(taxedFixture());
    expect(pdf).not.toMatch(/Ehtesham/i);
    expect(pdf).not.toMatch(/Shabbir/i);
    expect(pdf).not.toMatch(/Ehtisham/i);
  });
});

describe('both invoices', () => {
  it('thank the client', () => {
    expect(renderedText(invoiceFixture())).toContain('Thank You For Your Business');
    expect(renderedText(taxedFixture())).toContain('Thank You For Your Business');
  });

  it('render as a real PDF', () => {
    for (const invoice of [invoiceFixture(), taxedFixture()]) {
      const buf = renderInvoicePdf(invoice);
      expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(buf.length).toBeGreaterThan(1000);
    }
  });
});
