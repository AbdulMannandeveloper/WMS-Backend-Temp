'use strict';

/**
 * RFC 4180 CSV, with the one extra precaution a warehouse CSV needs: a string
 * cell that begins with = + - or @ is prefixed with a single quote, so a
 * consignee name like "=cmd" cannot be run as a formula when the file is opened
 * in a spreadsheet. Numbers are written as given, so a legitimate negative value
 * is not mangled — only strings are suspect.
 */

const NEEDS_QUOTING = /[",\r\n]/;
const FORMULA_LEAD = /^[=+\-@]/;

const escapeCell = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  let text = String(value);
  // Neutralise a spreadsheet formula injection in a text cell.
  if (FORMULA_LEAD.test(text)) text = `'${text}`;
  if (NEEDS_QUOTING.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
};

/**
 * @param {string[]} headers
 * @param {Array<Array<string|number|null>>} rows
 * @returns {string} CSV text with CRLF line endings and no trailing newline
 */
const toCsv = (headers, rows) => {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  return lines.join('\r\n');
};

module.exports = { toCsv, escapeCell };
