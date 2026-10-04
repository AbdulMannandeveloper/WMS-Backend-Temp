'use strict';

/**
 * Manifest uploads: the client's box list, parsed, validated, previewed, then
 * committed into boxes.
 *
 * Nothing is written to the flight when a file is uploaded — it is stored, read,
 * checked, and an AirFreightUpload row records the verdict in PREVIEW. The
 * operator sees the row errors and either discards or commits. Commit re-reads
 * and re-validates the stored file inside a locked transaction, because the
 * database may have changed since the preview (another flight took a tracking
 * number, a courier was deactivated), and only then creates the boxes.
 *
 * REPLACE throws away this flight's existing boxes first; APPEND keeps them, and
 * so counts them as duplicates. Both modes are refused once the flight leaves
 * DRAFT — a dispatched box list is locked.
 */

const crypto = require('crypto');
const path = require('path');
const ExcelJS = require('exceljs');

const { prisma } = require('../lib/prisma');
const { uploadBuffer, getObjectStream } = require('../lib/objectStorage');
const flightRepository = require('../repositories/air_freight_flight.repository');
const boxRepository = require('../repositories/air_freight_box.repository');
const eventRepository = require('../repositories/air_freight_event.repository');
const uploadRepository = require('../repositories/air_freight_upload.repository');
const courierRepository = require('../repositories/courier.repository');
const auditLogLogic = require('./audit_log.logic');
const { parseManifest } = require('../utils/manifestParser');
const { validateManifestRows, REQUIRED_COLUMNS, OPTIONAL_COLUMNS } = require('../utils/manifestValidation');
const { normaliseTracking } = require('../utils/airFreightTracking');
const { parseUuid } = require('../utils/queryFilters');
const { toCsv } = require('../utils/csvExport');

const COMMIT_TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 120_000 };
const UPLOAD_MODES = ['REPLACE', 'APPEND'];
const MAX_STORED_ERRORS = 2_000;

const audit = (actorUserId, action, details) => {
  if (!actorUserId) return Promise.resolve(null);
  return auditLogLogic
    .createAuditLog(actorUserId, action, details)
    .catch((err) => console.error(`Audit log error (${action}):`, err.message));
};

const withStatus = (message, status) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const requireDraftFlight = async (flightId, scopeClientId, tx) => {
  const flight = await flightRepository.getFlightCore(flightId, tx);
  if (!flight) throw withStatus('Flight not found.', 404);
  if (scopeClientId && flight.clientId !== scopeClientId) throw withStatus('Flight not found.', 404);
  if (flight.status !== 'DRAFT') {
    throw withStatus('A manifest can only be uploaded to a draft flight.', 409);
  }
  return flight;
};

/** Active couriers keyed by both code and name, lower-cased, for validation. */
const buildCourierIndex = async (tx) => {
  const couriers = await courierRepository.listCouriers({ activeOnly: true }, tx);
  const byKey = new Map();
  for (const c of couriers) {
    const entry = { id: c.id, code: c.code, isActive: c.isActive, trackingRegex: c.trackingRegex };
    byKey.set(c.code.toLowerCase(), entry);
    byKey.set(c.name.toLowerCase(), entry);
  }
  return { couriers, byKey };
};

const readStreamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

/**
 * Parses and validates a buffer against a flight's live context. Shared by
 * preview and commit so the two can never diverge in what they accept.
 */
const parseAndValidate = async (buffer, fileName, flightId, mode, tx) => {
  const { headers, rows } = await parseManifest(buffer, fileName);
  const { byKey } = await buildCourierIndex(tx);

  const trackingList = rows
    .map((r) => normaliseTracking(r.tracking_number))
    .filter(Boolean);
  const existingTracking = await boxRepository.existingTrackingNumbers(
    trackingList,
    // REPLACE is about to delete this flight's boxes, so they do not count as taken.
    { excludeFlightId: mode === 'REPLACE' ? flightId : undefined },
    tx,
  );

  const flight = await flightRepository.getFlightCore(flightId, tx);
  const result = validateManifestRows(
    rows,
    { couriersByKey: byKey, existingTracking, declaredPieces: flight?.declaredPieces ?? null },
    headers,
  );
  return { rows, ...result };
};

const coerceMode = (raw) => {
  const mode = String(raw ?? 'APPEND').trim().toUpperCase();
  if (!UPLOAD_MODES.includes(mode)) throw new Error('Upload mode must be REPLACE or APPEND.');
  return mode;
};

// ─── Preview ─────────────────────────────────────────────────────────────────

/**
 * Stores an uploaded manifest, validates it, and records the verdict in PREVIEW.
 * Writes no boxes. `file` is a multer memory file ({ buffer, originalname, mimetype }).
 */
const previewUpload = async (flightIdRaw, file, modeRaw, actorUserId, scopeClientId) => {
  const flightId = parseUuid(flightIdRaw, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);
  if (!file || !file.buffer) throw new Error('Upload a .csv or .xlsx manifest file.');
  const mode = coerceMode(modeRaw);

  await requireDraftFlight(flightId, scopeClientId);

  // Store the original first, so the committed import is always traceable to a file.
  const ext = path.extname(file.originalname || '').toLowerCase() || '.csv';
  const storageKey = `afmanifest-${flightId}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  await uploadBuffer(storageKey, file.buffer, file.mimetype || 'application/octet-stream');

  const { rows, valid, errors, warnings } = await parseAndValidate(
    file.buffer,
    file.originalname,
    flightId,
    mode,
  );

  const upload = await uploadRepository.createUpload({
    flightId,
    fileName: String(file.originalname || 'manifest').slice(0, 255),
    storageKey,
    fileType: String(file.mimetype || '').slice(0, 120),
    mode,
    status: 'PREVIEW',
    rowsTotal: rows.length,
    rowsOk: valid.length,
    rowsError: rows.length - valid.length,
    errors: errors.slice(0, MAX_STORED_ERRORS),
    warnings,
    uploadedByUserId: actorUserId,
  });

  await audit(actorUserId, 'AIR_FREIGHT_MANIFEST_PREVIEWED', {
    flightId,
    uploadId: upload.id,
    mode,
    rowsOk: valid.length,
    rowsError: rows.length - valid.length,
  });

  return upload;
};

// ─── Commit ────────────────────────────────────────────────────────────────────

/**
 * Turns a previewed upload into boxes, inside a locked transaction. Re-reads and
 * re-validates the stored file, because the preview may be minutes old; refuses
 * if the file now has no valid rows, or if the flight left DRAFT, or if the
 * upload is not in PREVIEW.
 */
const commitUpload = async (flightIdRaw, uploadIdRaw, actorUserId, scopeClientId) => {
  const flightId = parseUuid(flightIdRaw, 'Flight');
  const uploadId = parseUuid(uploadIdRaw, 'Upload');
  if (!flightId || !uploadId) throw withStatus('Upload not found.', 404);

  const result = await prisma.$transaction(async (tx) => {
    const { lockFlight } = require('./air_freight_flight.logic');
    await lockFlight(flightId, tx);
    await requireDraftFlight(flightId, scopeClientId, tx);

    const upload = await uploadRepository.getUploadById(uploadId, tx);
    if (!upload || upload.flightId !== flightId) throw withStatus('Upload not found.', 404);
    if (upload.status !== 'PREVIEW') {
      throw withStatus('This upload has already been committed or discarded.', 409);
    }

    const { stream } = await getObjectStream(upload.storageKey);
    const buffer = await readStreamToBuffer(stream);

    const { valid, errors } = await parseAndValidate(
      buffer,
      upload.fileName,
      flightId,
      upload.mode,
      tx,
    );
    if (valid.length === 0) {
      throw withStatus('The manifest has no valid rows to import.', 400);
    }

    if (upload.mode === 'REPLACE') {
      // Boxes cascade their events away; all are still MANIFESTED on a DRAFT.
      await boxRepository.deleteByFlight(flightId, tx);
    }

    const boxRows = valid.map((box) => ({ ...box, flightId, status: 'MANIFESTED' }));

    let created;
    try {
      created = await boxRepository.createManyAndReturn(boxRows, tx);
    } catch (error) {
      if (error?.code === 'P2002') {
        // Lost a race for a tracking number between re-validation and insert.
        throw withStatus(
          'A tracking number was taken by another box while importing. Try the upload again.',
          409,
        );
      }
      throw error;
    }

    await eventRepository.createEvents(
      created.map((box) => ({
        boxId: box.id,
        flightId,
        fromStatus: null,
        toStatus: 'MANIFESTED',
        eventType: 'MANIFESTED',
        source: 'CSV',
        userId: actorUserId,
      })),
      tx,
    );

    const version = (await uploadRepository.maxVersion(flightId, tx)) + 1;
    const committed = await uploadRepository.updateUpload(
      uploadId,
      {
        status: 'COMMITTED',
        version,
        committedAt: new Date(),
        rowsOk: valid.length,
        rowsError: errors.length,
        errors: errors.slice(0, MAX_STORED_ERRORS),
      },
      tx,
    );
    return { committed, boxes: created.length, mode: upload.mode };
  }, COMMIT_TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_MANIFEST_COMMITTED', {
    flightId,
    uploadId,
    mode: result.mode,
    boxes: result.boxes,
    version: result.committed.version,
  });
  return result.committed;
};

// ─── Discard & list ──────────────────────────────────────────────────────────

const discardUpload = async (flightIdRaw, uploadIdRaw, actorUserId, scopeClientId) => {
  const flightId = parseUuid(flightIdRaw, 'Flight');
  const uploadId = parseUuid(uploadIdRaw, 'Upload');
  if (!flightId || !uploadId) throw withStatus('Upload not found.', 404);

  const upload = await uploadRepository.getUploadById(uploadId);
  if (!upload || upload.flightId !== flightId) throw withStatus('Upload not found.', 404);
  if (scopeClientId && upload.flight.clientId !== scopeClientId) throw withStatus('Upload not found.', 404);
  if (upload.status !== 'PREVIEW') {
    throw withStatus('Only a previewed upload can be discarded.', 409);
  }

  const updated = await uploadRepository.updateUpload(uploadId, { status: 'DISCARDED' });
  await audit(actorUserId, 'AIR_FREIGHT_MANIFEST_DISCARDED', { flightId, uploadId });
  return updated;
};

const listUploads = async (flightIdRaw, scopeClientId) => {
  const flightId = parseUuid(flightIdRaw, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);
  const flight = await flightRepository.getFlightCore(flightId);
  if (!flight) throw withStatus('Flight not found.', 404);
  if (scopeClientId && flight.clientId !== scopeClientId) throw withStatus('Flight not found.', 404);
  return await uploadRepository.listByFlight(flightId);
};

const getUploadForFile = async (uploadIdRaw, scopeClientId) => {
  const uploadId = parseUuid(uploadIdRaw, 'Upload');
  if (!uploadId) throw withStatus('Upload not found.', 404);
  const upload = await uploadRepository.getUploadById(uploadId);
  if (!upload) throw withStatus('Upload not found.', 404);
  if (scopeClientId && upload.flight.clientId !== scopeClientId) throw withStatus('Upload not found.', 404);
  return upload;
};

// ─── Template ────────────────────────────────────────────────────────────────

/** The template's columns, in order: required first, then optional. */
const TEMPLATE_COLUMNS = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];

const EXAMPLE_ROWS = [
  {
    tracking_number: '1Z999AA10123456784', courier: 'UPS', weight_kg: '4.2',
    length_cm: '40', width_cm: '30', height_cm: '20', contents_description: 'Cotton bathrobes',
    declared_value: '35.00', currency: 'GBP', consignee_name: 'J Smith', consignee_postcode: 'M1 1AA',
    client_reference: 'SC-1001', reference: 'ORD-5567', hs_code: '620892',
  },
  {
    tracking_number: '15501234567890', courier: 'DPD', weight_kg: '2.1',
    length_cm: '30', width_cm: '20', height_cm: '15', contents_description: 'Leather wallets',
    declared_value: '18.50', currency: 'GBP', consignee_name: 'A Khan', consignee_postcode: 'B2 4QA',
    client_reference: 'SC-1002', reference: 'ORD-5568', hs_code: '420231',
  },
];

const renderTemplate = async (formatRaw) => {
  const format = String(formatRaw ?? 'csv').trim().toLowerCase();
  const activeCourierCodes = (await courierRepository.listCouriers({ activeOnly: true }))
    .map((c) => c.code);

  if (format === 'csv') {
    const rows = EXAMPLE_ROWS.map((row) => TEMPLATE_COLUMNS.map((col) => row[col] ?? ''));
    const buffer = Buffer.from(toCsv(TEMPLATE_COLUMNS, rows), 'utf8');
    return { buffer, fileName: 'air-freight-manifest-template.csv', contentType: 'text/csv; charset=utf-8' };
  }

  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Manifest');
    sheet.addRow(TEMPLATE_COLUMNS);
    sheet.getRow(1).font = { bold: true };
    for (const row of EXAMPLE_ROWS) sheet.addRow(TEMPLATE_COLUMNS.map((col) => row[col] ?? ''));

    const couriersSheet = workbook.addWorksheet('Couriers');
    couriersSheet.addRow(['code']);
    couriersSheet.getRow(1).font = { bold: true };
    for (const code of activeCourierCodes) couriersSheet.addRow([code]);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      fileName: 'air-freight-manifest-template.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  throw new Error('Template format must be csv or xlsx.');
};

module.exports = {
  previewUpload,
  commitUpload,
  discardUpload,
  listUploads,
  getUploadForFile,
  renderTemplate,
  TEMPLATE_COLUMNS,
  // Exported for tests.
  parseAndValidate,
};
