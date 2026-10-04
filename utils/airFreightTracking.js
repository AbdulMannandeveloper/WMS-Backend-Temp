'use strict';

/**
 * Normalising the two identifiers the air freight module leans on: the courier
 * tracking number on each box, and the master air waybill on the flight.
 *
 * Both are pure and have no database. A tracking number is read off a label by a
 * scanner, a camera or a person, so the same box can arrive as "ab 123", "AB123"
 * or "ab-123"; one spelling has to win before anything is compared or stored. A
 * MAWB is quoted every way airlines and forwarders write it, so it too is
 * reduced to one shape — and its check digit verified, because a transposed
 * digit there is a common and expensive mistake.
 */

/** The longest a tracking number may be; the column is VarChar(64). */
const MAX_TRACKING_LENGTH = 64;

/** Only letters, digits and hyphens survive; everything a scanner adds is noise. */
const TRACKING_PATTERN = /^[A-Z0-9-]+$/;

/**
 * One spelling of a tracking number: trimmed, every space removed, uppercased.
 *
 * Returns null when nothing usable is left — empty, too long, or carrying a
 * character a tracking number never has. The caller decides what null means (a
 * 400 at the bench, a row error in a manifest); this never throws, so a bad
 * scan cannot crash a scan loop.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
const normaliseTracking = (raw) => {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw).replace(/\s+/g, '').toUpperCase();
  if (!value || value.length > MAX_TRACKING_LENGTH) return null;
  if (!TRACKING_PATTERN.test(value)) return null;
  return value;
};

/**
 * A master air waybill reduced to NNN-NNNNNNNN, with its check digit verified.
 *
 * A MAWB is 11 digits: a 3-digit airline prefix and an 8-digit serial whose last
 * digit is the first seven taken as a number, modulo 7. We keep only the digits
 * and, when there are exactly eleven, format and check them. A wrong check digit
 * is reported, never rejected — the spec makes it a warning, because a forwarder
 * occasionally issues one that does not check out and the shipment is still real.
 *
 * @param {unknown} raw
 * @returns {{ value: string|null, checkDigitOk: boolean }}
 *   value is NNN-NNNNNNNN when eleven digits were found, the bare digits when
 *   some other count was, and null when none were. checkDigitOk is meaningful
 *   only for a well-formed eleven-digit number.
 */
const normaliseMawb = (raw) => {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { value: null, checkDigitOk: false };
  }
  const digits = String(raw).replace(/\D+/g, '');
  if (digits.length === 0) return { value: null, checkDigitOk: false };
  if (digits.length !== 11) return { value: digits, checkDigitOk: false };

  const airline = digits.slice(0, 3);
  const serial = digits.slice(3);
  const checkDigit = Number.parseInt(serial.slice(0, 7), 10) % 7;
  const checkDigitOk = checkDigit === Number.parseInt(serial[7], 10);

  return { value: `${airline}-${serial}`, checkDigitOk };
};

module.exports = {
  normaliseTracking,
  normaliseMawb,
  MAX_TRACKING_LENGTH,
  TRACKING_PATTERN,
};
