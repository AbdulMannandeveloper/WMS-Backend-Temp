'use strict';

/**
 * Deciding whether the rows manifestParser produced can become boxes.
 *
 * Pure: rows and a small context in, a verdict out. The context carries what the
 * rules need from the database without this module reaching for it — the active
 * couriers keyed by code and name, the set of tracking numbers already live, and
 * the flight's declared piece count — so the whole validator can be unit-tested
 * against fixtures.
 *
 * The output is shaped for the preview the operator sees before committing:
 *   - valid    the rows that would become boxes, already in box-input shape
 *   - errors   { row, column, message } — a row with any error becomes no box
 *   - warnings { row, column, message } — the row is still valid, but flagged
 *
 * Row numbers are the 1-based spreadsheet line (header is row 1), carried on each
 * row as `__row` by the parser, so a message points at what the user can see.
 */

const { normaliseTracking } = require('./airFreightTracking');

/** Every column a box cannot be built without. A missing header fails the file. */
const REQUIRED_COLUMNS = [
  'tracking_number',
  'courier',
  'weight_kg',
  'length_cm',
  'width_cm',
  'height_cm',
  'contents_description',
  'declared_value',
  'currency',
  'consignee_name',
  'consignee_postcode',
];

/** Columns we read when present, but never require. */
const OPTIONAL_COLUMNS = ['client_reference', 'reference', 'hs_code'];

/** The error list never grows past this; a wholly wrong file would otherwise be unbounded. */
const MAX_ERRORS = 2_000;

const err = (row, column, message) => ({ row, column, message });

/** A positive, finite number from a cell, or null when it is not one. */
const toPositiveNumber = (raw) => {
  const value = String(raw ?? '').trim();
  if (value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

/**
 * Validates manifest rows against a flight's context.
 *
 * @param {Array<Record<string,string>>} rows  from parseManifest (each has __row)
 * @param {{
 *   couriersByKey: Map<string, {id:string, code:string, isActive:boolean, trackingRegex:string|null}>,
 *   existingTracking: Set<string>,
 *   declaredPieces?: number|null,
 * }} ctx
 * @param {string[]} headers  the parsed header list, for the missing-column check
 * @returns {{ valid: object[], errors: object[], warnings: object[] }}
 */
const validateManifestRows = (rows, ctx = {}, headers = []) => {
  const { couriersByKey = new Map(), existingTracking = new Set(), declaredPieces = null } = ctx;

  const errors = [];
  const warnings = [];
  const valid = [];

  const pushError = (row, column, message) => {
    if (errors.length < MAX_ERRORS) errors.push(err(row, column, message));
  };

  // Whole-file check first: a missing required header means no row can be read,
  // so there is nothing else worth saying about the file.
  const present = new Set(headers);
  const missing = REQUIRED_COLUMNS.filter((c) => !present.has(c));
  if (missing.length > 0) {
    for (const column of missing) {
      pushError(1, column, `The manifest is missing the required column "${column}".`);
    }
    return { valid, errors, warnings };
  }

  // Tracking numbers seen earlier in this same file, so a duplicate inside the
  // upload is caught as well as one already in the database.
  const seenInFile = new Map();

  for (const row of rows) {
    const line = row.__row ?? 0;
    let rowOk = true;
    const fail = (column, message) => {
      pushError(line, column, message);
      rowOk = false;
    };

    // ── Tracking number ──
    const tracking = normaliseTracking(row.tracking_number);
    if (!tracking) {
      fail('tracking_number', 'Tracking number is missing or not a tracking number.');
    }

    // ── Courier ──
    const courierKey = String(row.courier ?? '').trim().toLowerCase();
    let courier = null;
    if (!courierKey) {
      fail('courier', 'Courier is missing.');
    } else {
      courier = couriersByKey.get(courierKey) ?? null;
      if (!courier) {
        fail('courier', `No courier matches "${row.courier}". Use one of the listed codes.`);
      } else if (!courier.isActive) {
        fail('courier', `Courier "${courier.code}" is deactivated.`);
      }
    }

    // Tracking must match the courier's pattern, when one is configured.
    if (tracking && courier && courier.trackingRegex) {
      let re = null;
      try {
        re = new RegExp(courier.trackingRegex);
      } catch {
        re = null; // A bad stored pattern never fails a client's row.
      }
      if (re && !re.test(tracking)) {
        fail('tracking_number', `Tracking ${tracking} does not match ${courier.code}'s format.`);
      }
    }

    // Duplicate within the file, or already live on another active box.
    if (tracking) {
      if (seenInFile.has(tracking)) {
        fail('tracking_number', `Tracking ${tracking} appears twice in this file (first on row ${seenInFile.get(tracking)}).`);
      } else {
        seenInFile.set(tracking, line);
      }
      if (existingTracking.has(tracking)) {
        fail('tracking_number', `Tracking ${tracking} is already on an active box.`);
      }
    }

    // ── Weight and dimensions ──
    const weightKg = toPositiveNumber(row.weight_kg);
    if (weightKg === null) fail('weight_kg', 'Weight must be a number greater than zero.');
    const lengthCm = toPositiveNumber(row.length_cm);
    if (lengthCm === null) fail('length_cm', 'Length must be a number greater than zero.');
    const widthCm = toPositiveNumber(row.width_cm);
    if (widthCm === null) fail('width_cm', 'Width must be a number greater than zero.');
    const heightCm = toPositiveNumber(row.height_cm);
    if (heightCm === null) fail('height_cm', 'Height must be a number greater than zero.');

    // ── Customs ──
    const contentsDescription = String(row.contents_description ?? '').trim();
    if (!contentsDescription) {
      fail('contents_description', 'A contents description is required.');
    } else if (contentsDescription.length > 255) {
      fail('contents_description', 'Contents description is too long (255 characters maximum).');
    }

    const declaredValue = toPositiveNumber(row.declared_value);
    if (declaredValue === null) fail('declared_value', 'Declared value must be a number greater than zero.');

    const currency = String(row.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      fail('currency', 'Currency must be a 3-letter code, e.g. GBP.');
    }

    const consigneeName = String(row.consignee_name ?? '').trim();
    if (!consigneeName) fail('consignee_name', 'Consignee name is required.');
    else if (consigneeName.length > 160) fail('consignee_name', 'Consignee name is too long (160 characters maximum).');

    const consigneePostcode = String(row.consignee_postcode ?? '').trim();
    if (!consigneePostcode) fail('consignee_postcode', 'Consignee postcode is required.');
    else if (consigneePostcode.length > 20) fail('consignee_postcode', 'Consignee postcode is too long (20 characters maximum).');

    // ── Optional fields ──
    const hsCodeRaw = String(row.hs_code ?? '').trim();
    let hsCode = null;
    if (hsCodeRaw) {
      const digits = hsCodeRaw.replace(/\s+/g, '');
      if (!/^\d{6,10}$/.test(digits)) {
        fail('hs_code', 'HS code must be 6 to 10 digits.');
      } else {
        hsCode = digits;
      }
    }

    const clientReference = String(row.client_reference ?? '').trim().slice(0, 80) || null;
    const reference = String(row.reference ?? '').trim().slice(0, 80) || null;

    if (!rowOk) continue;

    valid.push({
      trackingNumber: tracking,
      courierId: courier.id,
      clientReference,
      reference,
      declaredWeightKg: weightKg,
      lengthCm,
      widthCm,
      heightCm,
      contentsDescription,
      hsCode,
      declaredValue,
      currency,
      consigneeName,
      consigneePostcode,
    });
  }

  // A piece-count mismatch is a warning, not a failure: the count is declared
  // before the boxes are listed and often drifts by one.
  if (Number.isInteger(declaredPieces) && declaredPieces > 0 && valid.length !== declaredPieces) {
    warnings.push(
      err(
        1,
        'declared_pieces',
        `The flight declares ${declaredPieces} pieces, but ${valid.length} valid box(es) were read.`,
      ),
    );
  }

  return { valid, errors, warnings };
};

module.exports = {
  validateManifestRows,
  REQUIRED_COLUMNS,
  OPTIONAL_COLUMNS,
  MAX_ERRORS,
};
