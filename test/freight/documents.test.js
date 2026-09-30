/**
 * The booking receipt attached to a freight shipment.
 *
 * Two things are being pinned here. First, that the uploaded file stays tied to
 * the shipment with enough recorded about it to be useful — name, type, storage
 * key, uploader, time. Second, that the download route cannot be talked into
 * serving anything else: these are customers' booking slips with names and
 * addresses on them, and the uploads directory is not public.
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
let shipment;

// A byte-for-byte valid minimal PDF, so the multer filter and the mime sniffing
// both see what the extension claims.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

beforeEach(async () => {
  admin = await makeAdmin();
  const { user } = await makeEmployee();
  staff = user;
  await grantPermissions(staff, ['freight:read', 'freight:update']);
  shipment = await makeFreightShipment();
});

const upload = (actor = admin, buffer = PDF, filename = 'booking-receipt.pdf') =>
  as(actor)
    .post(`/api/freight-shipments/${shipment.id}/documents`)
    .attach('document', buffer, filename);

describe('uploading a booking receipt', () => {
  it('stores the file against the shipment with its name, type, uploader and time', async () => {
    const res = await upload();

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      freightShipmentId: shipment.id,
      fileName: 'booking-receipt.pdf',
      fileType: 'application/pdf',
      uploadedByUserId: admin.id,
    });
    expect(res.body.storageKey).toMatch(new RegExp(`^freight-${shipment.id}-\\d+-\\d+\\.pdf$`));
    expect(res.body.url).toBe(`/api/freight-shipments/documents/${res.body.storageKey}`);
    expect(res.body.uploadedAt).toBeTruthy();
  });

  it('shows on the shipment detail, newest first', async () => {
    await upload(admin, PDF, 'first.pdf');
    await upload(admin, PDF, 'second.pdf');

    const res = await as(admin).get(`/api/freight-shipments/${shipment.id}`);

    expect(res.body.documents.map((d) => d.fileName)).toEqual(['second.pdf', 'first.pdf']);
  });

  it('refuses a file type the warehouse does not accept', async () => {
    const res = await as(admin)
      .post(`/api/freight-shipments/${shipment.id}/documents`)
      .attach('document', Buffer.from('#!/bin/sh\n'), 'run.sh');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.freightShipmentDocument.count()).toBe(0);
  });

  it('refuses a request with no file', async () => {
    const res = await as(admin).post(`/api/freight-shipments/${shipment.id}/documents`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file uploaded/i);
  });

  it('answers 404 for a shipment that does not exist', async () => {
    const res = await as(admin)
      .post('/api/freight-shipments/11111111-1111-1111-1111-111111111111/documents')
      .attach('document', PDF, 'orphan.pdf');

    expect(res.status).toBe(404);
  });

  it('needs the update grant and a session', async () => {
    expect((await upload(staff)).status).toBe(201);

    const { user: ungranted } = await makeEmployee();
    expect((await upload(ungranted)).status).toBe(403);

    expect(
      (
        await anon()
          .post(`/api/freight-shipments/${shipment.id}/documents`)
          .attach('document', PDF, 'anon.pdf')
      ).status,
    ).toBe(401);
  });
});

describe('reading a booking receipt back', () => {
  it('streams the file with its original name', async () => {
    const { body: document } = await upload();

    const res = await as(staff).get(
      `/api/freight-shipments/documents/${document.storageKey}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toContain('booking-receipt.pdf');
  });

  it('serves only keys this module recorded', async () => {
    // A real object could exist under another module's key; the documents table is
    // what decides whether this route will hand it over.
    const res = await as(admin).get(
      '/api/freight-shipments/documents/receipt-1234567890-1.pdf',
    );

    expect(res.status).toBe(404);
  });

  it('refuses a path rather than a file name', async () => {
    const res = await as(admin).get(
      '/api/freight-shipments/documents/..%2F..%2Fpackage.json',
    );

    expect(res.status).toBe(400);
  });

  it('is not readable without a session', async () => {
    const { body: document } = await upload();

    const res = await anon().get(
      `/api/freight-shipments/documents/${document.storageKey}`,
    );

    expect(res.status).toBe(401);
  });
});

describe('removing a booking receipt', () => {
  it('detaches the document from the shipment', async () => {
    const { body: document } = await upload();

    const res = await as(staff).delete(
      `/api/freight-shipments/${shipment.id}/documents/${document.id}`,
    );

    expect(res.status).toBe(200);
    expect(await prisma.freightShipmentDocument.count()).toBe(0);
  });

  it('refuses a document belonging to a different shipment', async () => {
    const { body: document } = await upload();
    const other = await makeFreightShipment();

    const res = await as(admin).delete(
      `/api/freight-shipments/${other.id}/documents/${document.id}`,
    );

    expect(res.status).toBe(404);
    expect(await prisma.freightShipmentDocument.count()).toBe(1);
  });
});
