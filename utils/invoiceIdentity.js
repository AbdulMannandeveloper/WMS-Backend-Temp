'use strict';

/**
 * Which company an invoice is issued by.
 *
 * Work that carries tax is billed by Nayoram Ltd, the VAT-registered entity;
 * everything else by Pro Packers UK, which is not VAT registered. That single
 * fact changes the company name, the phone number, the email, the website, the
 * bank account the client pays into, the colour of the header band and whether
 * registration numbers appear in the footer.
 *
 * All of it lives in one table for that reason. Held as separate constants
 * scattered through the renderer, one of them eventually gets updated without
 * the others — and the failure mode there is a client paying money into the
 * wrong bank account, which is not something a test would notice.
 *
 * The address is shared: both trade from the same premises.
 */

const SHARED_ADDRESS = {
  lines: ['Greenfield Mill, Greenfield Road', 'Colne, England', 'BB89PW'],
  /** One-line form, for the footer. */
  oneLine: 'Greenfield Mill, Greenfield Road, Colne, England, BB89PW',
};

/**
 * Pro Packers UK — not VAT registered, so no registration line on its invoices.
 * Red header, taken from the supplied template (0.7765 0.1569 0.1569 rg).
 */
const PRO_PACKERS = {
  key: 'PRO_PACKERS',
  companyName: 'Pro Packers UK',
  phone: '073 77283716',
  email: 'support@propackers.uk',
  website: 'www.propackers.uk',
  address: SHARED_ADDRESS,
  headerColor: [198, 40, 40],
  bank: {
    name: 'Pro Packers Uk',
    sortCode: '60-84-64',
    accountNumber: '21929729',
  },
  // Not VAT registered. Deliberately no company or VAT number: printing another
  // entity's registration under this name would be a misstatement on a tax
  // document, not a cosmetic slip.
  registration: null,
  vatRegistered: false,
};

/** Nayoram Ltd — the VAT-registered entity. Blue header. */
const NAYORAM = {
  key: 'NAYORAM',
  companyName: 'Nayoram Ltd',
  phone: '07377 283716',
  email: 'support@nayoram.com',
  website: 'www.nayoram.com',
  address: SHARED_ADDRESS,
  headerColor: [21, 62, 138],
  bank: {
    name: 'Nayoram Ltd',
    sortCode: '01-00-04',
    accountNumber: '17817110',
  },
  registration: {
    companyNumber: '13376451',
    vatNumber: '505219714',
  },
  vatRegistered: true,
};

/**
 * The entity an invoice is issued by.
 *
 * Driven by whether tax was actually charged, not by the taxApplied flag alone:
 * an invoice with the box ticked but a zero rate carries no VAT, so it is not a
 * Nayoram invoice.
 */
const identityFor = (invoice) => {
  const taxed =
    Boolean(invoice?.taxApplied) && Number(invoice?.taxAmount ?? 0) > 0;
  return taxed ? NAYORAM : PRO_PACKERS;
};

module.exports = {
  PRO_PACKERS,
  NAYORAM,
  SHARED_ADDRESS,
  identityFor,
};
