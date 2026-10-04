/**
 * Manifest uploads — the client's box list becoming boxes.
 *
 * A file is stored, parsed and validated into a PREVIEW; nothing is written to
 * the flight until commit, which re-reads and re-validates the stored file
 * inside a locked transaction. CSV and Excel are both accepted, headers are
 * matched through an alias map, and a dispatched flight's list is locked.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';

import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeClient,
  makeCourier,
  makeAirFreightBox,
  grantPermissions,
} from '../factories/index.js';

let admin;
let client;
let courier;

const HEADERS = [
  'tracking_number', 'courier', 'weight_kg', 'length_cm', 'width_cm', 'height_cm',
  'contents_description', 'declared_value', 'currency', 'consignee_name', 'consignee_postcode',
];

const rowValues = (i) => [
  `TRK${String(i).padStart(7, '0')}`, 'UPS', '4.2', '40', '30', '20',
  'Cotton robes', '35.00', 'GBP', 'J Smith', 'M1 1AA',
];

const csvFor = (count, { headers = HEADERS, bom = false } = {}) => {
  const lines = [headers.join(',')];
  for (let i = 1; i <= count; i += 1) lines.push(rowValues(i).join(','));
  return Buffer.from((bom ? '﻿' : '') + lines.join('\n'), 'utf8');
};

const xlsxFor = async (count) => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Manifest');
  sheet.addRow(HEADERS);
  for (let i = 1; i <= count; i += 1) sheet.addRow(rowValues(i));
  return Buffer.from(await wb.xlsx.writeBuffer());
};

const newFlight = async () => {
  const res = await as(admin).post('/api/air-freight/flights').send({
    clientId: client.id,
    originLocation: 'Lahore (LHE)',
    destinationLocation: 'London Heathrow (LHR)',
    mawbNumber: '176-12345675',
  });
  return res.body;
};

const preview = (flightId, buffer, filename, contentType, mode = 'APPEND') =>
  as(admin)
    .post(`/api/air-freight/flights/${flightId}/uploads`)
    .field('mode', mode)
    .attach('file', buffer, { filename, contentType });

beforeEach(async () => {
  admin = await makeAdmin();
  client = (await makeClient()).client;
  courier = await makeCourier({ code: 'UPS', name: 'UPS' });
});

describe('CSV happy path', () => {
  it('previews then commits into boxes', async () => {
    const flight = await newFlight();
    const pv = await preview(flight.id, csvFor(3), 'm.csv', 'text/csv');
    expect(pv.status).toBe(201);
    expect(pv.body.rowsOk).toBe(3);
    expect(pv.body.rowsError).toBe(0);
    expect(pv.body.status).toBe('PREVIEW');

    const commit = await as(admin).post(
      `/api/air-freight/flights/${flight.id}/uploads/${pv.body.id}/commit`,
    );
    expect(commit.status).toBe(200);
    expect(commit.body.status).toBe('COMMITTED');
    expect(commit.body.version).toBe(1);

    const detail = await as(admin).get(`/api/air-freight/flights/${flight.id}`);
    expect(detail.body.boxCounts.MANIFESTED).toBe(3);
  });
});

describe('XLSX happy path', () => {
  it('reads an Excel workbook', async () => {
    const flight = await newFlight();
    const buffer = await xlsxFor(4);
    const pv = await preview(
      flight.id,
      buffer,
      'm.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(pv.status).toBe(201);
    expect(pv.body.rowsOk).toBe(4);
  });
});

describe('a 500-row real-shaped manifest', () => {
  it('commits 500 boxes from CSV', async () => {
    const flight = await newFlight();
    const pv = await preview(flight.id, csvFor(500), 'big.csv', 'text/csv');
    expect(pv.body.rowsOk).toBe(500);
    const commit = await as(admin).post(
      `/api/air-freight/flights/${flight.id}/uploads/${pv.body.id}/commit`,
    );
    expect(commit.status).toBe(200);
    const detail = await as(admin).get(`/api/air-freight/flights/${flight.id}`);
    expect(detail.body.boxCounts.MANIFESTED).toBe(500);
  });

  it('commits 500 boxes from XLSX', async () => {
    const flight = await newFlight();
    const pv = await preview(
      flight.id,
      await xlsxFor(500),
      'big.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(pv.body.rowsOk).toBe(500);
    const commit = await as(admin).post(
      `/api/air-freight/flights/${flight.id}/uploads/${pv.body.id}/commit`,
    );
    expect(commit.status).toBe(200);
    const detail = await as(admin).get(`/api/air-freight/flights/${flight.id}`);
    expect(detail.body.boxCounts.MANIFESTED).toBe(500);
  });
});

describe('a bad file', () => {
  it('reports a missing required header as a whole-file error', async () => {
    const flight = await newFlight();
    const headers = HEADERS.filter((h) => h !== 'currency');
    const pv = await preview(flight.id, csvFor(2, { headers }), 'm.csv', 'text/csv');
    expect(pv.status).toBe(201);
    expect(pv.body.rowsOk).toBe(0);
    expect(pv.body.errors.some((e) => e.column === 'currency')).toBe(true);
  });

  it('reports row errors: duplicate, unknown courier, bad number', async () => {
    const flight = await newFlight();
    const lines = [
      HEADERS.join(','),
      ['TRKDUP', 'UPS', '4', '40', '30', '20', 'A', '10', 'GBP', 'N', 'P'].join(','),
      ['TRKDUP', 'UPS', '4', '40', '30', '20', 'A', '10', 'GBP', 'N', 'P'].join(','),
      ['TRK9', 'NOPE', '4', '40', '30', '20', 'A', '10', 'GBP', 'N', 'P'].join(','),
      ['TRK10', 'UPS', '0', '40', '30', '20', 'A', '10', 'GBP', 'N', 'P'].join(','),
    ].join('\n');
    const pv = await preview(flight.id, Buffer.from(lines), 'm.csv', 'text/csv');
    expect(pv.body.rowsOk).toBe(1);
    const cols = pv.body.errors.map((e) => `${e.row}:${e.column}`);
    expect(cols).toContain('3:tracking_number'); // duplicate
    expect(cols).toContain('4:courier'); // unknown
    expect(cols).toContain('5:weight_kg'); // zero
  });

  it('refuses a commit with no valid rows', async () => {
    const flight = await newFlight();
    const lines = [HEADERS.join(','), ['', 'NOPE', '0', '0', '0', '0', '', '', '', '', ''].join(',')].join('\n');
    const pv = await preview(flight.id, Buffer.from(lines), 'm.csv', 'text/csv');
    const commit = await as(admin).post(
      `/api/air-freight/flights/${flight.id}/uploads/${pv.body.id}/commit`,
    );
    expect(commit.status).toBe(400);
  });
});

describe('header aliases and BOM', () => {
  it('maps tracking/weight/contents and strips a BOM', async () => {
    const flight = await newFlight();
    const headers = ['tracking', 'courier', 'weight', 'length_cm', 'width_cm', 'height_cm',
      'contents', 'declared_value', 'currency', 'consignee', 'postcode'];
    const pv = await preview(flight.id, csvFor(2, { headers, bom: true }), 'm.csv', 'text/csv');
    expect(pv.body.rowsOk).toBe(2);
  });
});

describe('replace and append', () => {
  it('APPEND keeps existing boxes; REPLACE clears them', async () => {
    const flight = await newFlight();
    const first = await preview(flight.id, csvFor(2), 'a.csv', 'text/csv', 'APPEND');
    await as(admin).post(`/api/air-freight/flights/${flight.id}/uploads/${first.body.id}/commit`);

    // Append two fresh tracking numbers (3 and 4).
    const lines = [HEADERS.join(','), rowValues(3).join(','), rowValues(4).join(',')].join('\n');
    const second = await preview(flight.id, Buffer.from(lines), 'b.csv', 'text/csv', 'APPEND');
    expect(second.body.rowsOk).toBe(2);
    await as(admin).post(`/api/air-freight/flights/${flight.id}/uploads/${second.body.id}/commit`);
    let detail = await as(admin).get(`/api/air-freight/flights/${flight.id}`);
    expect(detail.body.boxCounts.MANIFESTED).toBe(4);

    // Replace with a single row — the earlier four go, even though row 1 reuses
    // a tracking number already on this flight (REPLACE excludes its own boxes).
    const replace = await preview(flight.id, csvFor(1), 'c.csv', 'text/csv', 'REPLACE');
    expect(replace.body.rowsOk).toBe(1);
    await as(admin).post(`/api/air-freight/flights/${flight.id}/uploads/${replace.body.id}/commit`);
    detail = await as(admin).get(`/api/air-freight/flights/${flight.id}`);
    expect(detail.body.boxCounts.MANIFESTED).toBe(1);
  });

  it('APPEND blocks a tracking number already live on the flight', async () => {
    const flight = await newFlight();
    const first = await preview(flight.id, csvFor(1), 'a.csv', 'text/csv', 'APPEND');
    await as(admin).post(`/api/air-freight/flights/${flight.id}/uploads/${first.body.id}/commit`);
    const again = await preview(flight.id, csvFor(1), 'a.csv', 'text/csv', 'APPEND');
    expect(again.body.rowsOk).toBe(0);
    expect(again.body.errors.some((e) => e.column === 'tracking_number')).toBe(true);
  });
});

describe('commit re-validates against the live database', () => {
  it('fails a row whose tracking number was taken between preview and commit', async () => {
    const flight = await newFlight();
    const pv = await preview(flight.id, csvFor(1), 'a.csv', 'text/csv', 'APPEND');
    expect(pv.body.rowsOk).toBe(1);

    // Another box grabs TRK0000001 before this upload commits.
    await makeAirFreightBox(null, courier.id, { trackingNumber: 'TRK0000001' });

    const commit = await as(admin).post(
      `/api/air-freight/flights/${flight.id}/uploads/${pv.body.id}/commit`,
    );
    expect(commit.status).toBe(400); // no valid rows survive re-validation
  });
});

describe('locking and limits', () => {
  it('refuses an upload once the flight is dispatched', async () => {
    const flight = await newFlight();
    await makeAirFreightBox(flight.id, courier.id);
    await as(admin).post(`/api/air-freight/flights/${flight.id}/dispatch`);
    const pv = await preview(flight.id, csvFor(1), 'a.csv', 'text/csv');
    expect(pv.status).toBe(409);
  });

  it('refuses more than 20,000 rows', async () => {
    const flight = await newFlight();
    const pv = await preview(flight.id, csvFor(20001), 'huge.csv', 'text/csv');
    expect(pv.status).toBe(400);
  });

  it('refuses dispatch while an upload is still in preview', async () => {
    const flight = await newFlight();
    await makeAirFreightBox(flight.id, courier.id);
    await preview(flight.id, csvFor(1), 'a.csv', 'text/csv');
    const res = await as(admin).post(`/api/air-freight/flights/${flight.id}/dispatch`);
    expect(res.status).toBe(400);
  });
});

describe('template download', () => {
  it('serves a CSV and an XLSX template', async () => {
    const csv = await as(admin).get('/api/air-freight/manifest-template?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/csv/);
    expect(csv.text.split('\n')[0]).toContain('tracking_number');

    const xlsx = await as(admin).get('/api/air-freight/manifest-template?format=xlsx');
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheet/);
  });
});
