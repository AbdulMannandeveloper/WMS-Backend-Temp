'use strict';

/**
 * Turning an uploaded manifest file into rows, before anything is validated.
 *
 * A client exports their box list from whatever system they keep it in, so it
 * arrives as CSV or as an Excel workbook, with headers spelled however that
 * system spells them. This module's only job is to produce a clean header list
 * and an array of plain `{ header: value }` rows; deciding whether those rows
 * are any good is manifestValidation's job.
 *
 * It is pure — a buffer in, rows out — so the whole of it is unit-testable
 * without a flight, a request or the disk.
 */

const { parse: parseCsvSync } = require('csv-parse/sync');
const ExcelJS = require('exceljs');

/** No manifest the module accepts is larger than this; a mis-export is refused early. */
const MAX_ROWS = 20_000;

/**
 * Header spellings we accept for the canonical column names. The key is what we
 * work in; the values are what clients' systems emit. Everything is compared
 * lower-cased with spaces and hyphens folded to underscores, so only genuine
 * synonyms need listing here.
 */
const HEADER_ALIASES = {
  tracking_number: ['tracking', 'tracking_no', 'trackingno', 'tracking_number', 'awb', 'consignment'],
  client_reference: ['client_reference', 'sub_client_code', 'subclient_code', 'sub_client', 'client_ref'],
  reference: ['reference', 'ref', 'order_reference', 'order_ref'],
  weight_kg: ['weight', 'weight_kg', 'weightkg', 'kg', 'gross_weight'],
  length_cm: ['length', 'length_cm', 'l_cm', 'length_cms'],
  width_cm: ['width', 'width_cm', 'w_cm', 'width_cms'],
  height_cm: ['height', 'height_cm', 'h_cm', 'height_cms'],
  contents_description: ['contents_description', 'contents', 'description', 'goods_description', 'goods'],
  hs_code: ['hs_code', 'hscode', 'commodity_code', 'tariff_code'],
  declared_value: ['declared_value', 'value', 'customs_value', 'declared_val'],
  currency: ['currency', 'ccy', 'currency_code'],
  consignee_name: ['consignee_name', 'consignee', 'recipient', 'recipient_name', 'deliver_to'],
  consignee_postcode: ['consignee_postcode', 'postcode', 'post_code', 'zip', 'zip_code', 'recipient_postcode'],
  courier: ['courier', 'carrier', 'courier_code', 'carrier_code', 'service'],
};

/** Reverse lookup: a normalised source header → the canonical name, or itself. */
const ALIAS_TO_CANONICAL = (() => {
  const map = new Map();
  for (const [canonical, spellings] of Object.entries(HEADER_ALIASES)) {
    for (const spelling of spellings) map.set(spelling, canonical);
  }
  return map;
})();

/** lower-case, trim, fold runs of spaces/hyphens to a single underscore. */
const normaliseHeader = (raw) => {
  const base = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return ALIAS_TO_CANONICAL.get(base) ?? base;
};

/** An xlsx file is a zip; its first four bytes are the local-file-header magic. */
const looksLikeZip = (buffer) =>
  Buffer.isBuffer(buffer) &&
  buffer.length >= 4 &&
  buffer[0] === 0x50 &&
  buffer[1] === 0x4b &&
  (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
  (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08);

const isXlsxName = (fileName) => /\.xlsx$/i.test(String(fileName ?? ''));
const isCsvName = (fileName) => /\.csv$/i.test(String(fileName ?? ''));

/** A row is empty when every cell is blank — skip it rather than error on it. */
const rowIsEmpty = (row) => Object.values(row).every((v) => String(v ?? '').trim() === '');

const tooManyRows = () => {
  const error = new Error(`A manifest may have at most ${MAX_ROWS.toLocaleString('en-GB')} rows.`);
  error.status = 400;
  return error;
};

/** Pairs a header list with a data row, keeping the first value for a repeated header. */
const zipRow = (headers, cells) => {
  const row = {};
  headers.forEach((header, index) => {
    if (!header) return;
    if (header in row) return;
    row[header] = cells[index];
  });
  return row;
};

const parseCsv = (buffer) => {
  const records = parseCsvSync(buffer, {
    bom: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    columns: false,
  });
  if (records.length === 0) return { headers: [], rows: [] };

  const headers = records[0].map(normaliseHeader);
  const dataRecords = records.slice(1);
  if (dataRecords.length > MAX_ROWS) throw tooManyRows();

  const rows = [];
  dataRecords.forEach((cells, index) => {
    const row = zipRow(headers, cells.map((c) => String(c ?? '').trim()));
    // The spreadsheet row number the user sees: header is row 1.
    row.__row = index + 2;
    if (!rowIsEmpty(row)) rows.push(row);
  });
  return { headers, rows };
};

const parseXlsx = async (buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  // `.text` gives the rendered string for every cell type, so a number keyed as
  // text and a formatted date both read the way the client sees them.
  const cellText = (cell) => String(cell?.text ?? '').trim();

  const headerRow = sheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = normaliseHeader(cellText(cell));
  });

  if (sheet.actualRowCount - 1 > MAX_ROWS) throw tooManyRows();

  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (excelRow, rowNumber) => {
    if (rowNumber === 1) return;
    const cells = [];
    excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cellText(cell);
    });
    const row = zipRow(headers, cells);
    row.__row = rowNumber;
    if (!rowIsEmpty(row)) rows.push(row);
  });

  return { headers, rows };
};

/**
 * Parses a manifest buffer into `{ headers, rows }`.
 *
 * The format is decided by the file name and, for xlsx, confirmed by the zip
 * signature — a browser's mime type is not trusted (see middlewares/manifestUpload).
 * Each row carries a `__row` field: its 1-based spreadsheet line, so a later
 * validation error can point the user at the row they can see.
 *
 * @param {Buffer} buffer
 * @param {string} fileName
 * @returns {Promise<{ headers: string[], rows: Array<Record<string,string>> }>}
 */
const parseManifest = async (buffer, fileName) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const error = new Error('The manifest file is empty.');
    error.status = 400;
    throw error;
  }

  if (isXlsxName(fileName) && looksLikeZip(buffer)) return await parseXlsx(buffer);
  if (isCsvName(fileName)) return parseCsv(buffer);

  // An .xlsx that is not a zip, or any other extension, is not something we can
  // read — the upload filter should have caught it, so this is the backstop.
  const error = new Error('Upload a .csv or .xlsx manifest file.');
  error.status = 400;
  throw error;
};

module.exports = {
  parseManifest,
  normaliseHeader,
  looksLikeZip,
  HEADER_ALIASES,
  MAX_ROWS,
};
