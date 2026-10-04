/**
 * The pricing engine (§5) — pure, no database.
 *
 * The golden flight must reproduce exactly, and the knobs a single price cannot
 * express (method, divisor, rounding, free storage) each change the answer the
 * documented way. A missing rate omits its line rather than inventing a price.
 */

import { describe, it, expect } from 'vitest';

import { calculateFlightCharges } from '../../utils/airFreightCharges.js';

const d = (s) => new Date(s);

const GOLDEN_BOXES = [
  { id: 'A', status: 'HANDED_TO_COURIER', receivedAt: d('2026-10-10T09:00:00Z'), handedOverAt: d('2026-10-11T10:00:00Z'), declaredWeightKg: 4.2, lengthCm: 40, widthCm: 30, heightCm: 20, clientReference: 'X' },
  { id: 'B', status: 'HANDED_TO_COURIER', receivedAt: d('2026-10-10T09:00:00Z'), handedOverAt: d('2026-10-11T10:00:00Z'), declaredWeightKg: 2.1, lengthCm: 30, widthCm: 20, heightCm: 15, clientReference: 'X' },
  { id: 'C', status: 'HANDED_TO_COURIER', receivedAt: d('2026-10-10T09:00:00Z'), handedOverAt: d('2026-10-14T15:00:00Z'), declaredWeightKg: 3.0, lengthCm: 60, widthCm: 40, heightCm: 40, clientReference: 'Y' },
  { id: 'D', status: 'SHORT', receivedAt: null, declaredWeightKg: 10, lengthCm: 50, widthCm: 40, heightCm: 30 },
];
const EXCEPTIONS = [{ type: 'DAMAGED', chargeable: true, boxId: 'C' }];
const RATES = { perKg: { unitPrice: 0.8 }, perBox: { unitPrice: 1.5 }, storage: { unitPrice: 0.5 }, damage: { unitPrice: 2.0 } };
const SETTINGS = { method: 'PER_BOX', divisor: 6000, roundingIncrementKg: 0.5, freeStorageHours: 48 };
const NOW = d('2026-10-20T00:00:00Z');

describe('golden flight', () => {
  it('PER_BOX totals 26.40', () => {
    const r = calculateFlightCharges({ boxes: GOLDEN_BOXES, exceptions: EXCEPTIONS, rates: RATES, settings: SETTINGS, now: NOW });
    expect(r.totals.chargeableKg).toBe(23);
    expect(r.totals.storageBoxDays).toBe(3);
    expect(r.totals.total).toBe(26.4);
    expect(r.totals.billedBoxes).toBe(3); // D excluded (never received)
  });

  it('FLIGHT_TOTAL totals 25.20', () => {
    const r = calculateFlightCharges({ boxes: GOLDEN_BOXES, exceptions: EXCEPTIONS, rates: RATES, settings: { ...SETTINGS, method: 'FLIGHT_TOTAL' }, now: NOW });
    expect(r.totals.chargeableKg).toBe(21.5);
    expect(r.totals.total).toBe(25.2);
  });
});

describe('rounding and divisor', () => {
  const one = (settings) => calculateFlightCharges({
    boxes: [{ id: 'A', status: 'RECEIVED', receivedAt: d('2026-10-10T09:00:00Z'), declaredWeightKg: 4.2, lengthCm: 40, widthCm: 30, heightCm: 20 }],
    exceptions: [], rates: { perKg: { unitPrice: 1 } }, settings, now: d('2026-10-10T10:00:00Z'),
  }).totals.chargeableKg;

  it('rounds to 0.5 / 1 / none', () => {
    expect(one({ method: 'PER_BOX', divisor: 6000, roundingIncrementKg: 0.5, freeStorageHours: 48 })).toBe(4.5);
    expect(one({ method: 'PER_BOX', divisor: 6000, roundingIncrementKg: 1, freeStorageHours: 48 })).toBe(5);
    expect(one({ method: 'PER_BOX', divisor: 6000, roundingIncrementKg: 0, freeStorageHours: 48 })).toBe(4.2);
  });

  it('a smaller divisor raises the volumetric weight', () => {
    // 40×30×20 = 24000 cm³; /5000 = 4.8 kg volumetric > 4.2 actual (no rounding).
    expect(one({ method: 'PER_BOX', divisor: 5000, roundingIncrementKg: 0, freeStorageHours: 48 })).toBe(4.8)
  });
});

describe('storage edges', () => {
  const days = (receivedAt, handedOverAt, freeStorageHours) => calculateFlightCharges({
    boxes: [{ id: 'A', status: 'HANDED_TO_COURIER', receivedAt: d(receivedAt), handedOverAt: d(handedOverAt), declaredWeightKg: 1, lengthCm: 1, widthCm: 1, heightCm: 1 }],
    exceptions: [], rates: { storage: { unitPrice: 1 } }, settings: { method: 'PER_BOX', divisor: 6000, roundingIncrementKg: 0.5, freeStorageHours }, now: NOW,
  }).totals.storageBoxDays;

  it('exactly the free window is 0 days; one minute over is 1 day', () => {
    expect(days('2026-10-10T00:00:00Z', '2026-10-12T00:00:00Z', 48)).toBe(0); // exactly 48h
    expect(days('2026-10-10T00:00:00Z', '2026-10-12T00:01:00Z', 48)).toBe(1); // 48h + 1min
  });
});

describe('missing rates', () => {
  it('omits a line when the rate is null or zero', () => {
    const r = calculateFlightCharges({ boxes: GOLDEN_BOXES, exceptions: EXCEPTIONS, rates: { perKg: { unitPrice: 0.8 }, perBox: null, storage: { unitPrice: 0 }, damage: { unitPrice: 2 } }, settings: SETTINGS, now: NOW });
    const codes = r.lines.map((l) => l.code);
    expect(codes).toContain('AIRFREIGHT_PER_KG');
    expect(codes).not.toContain('AIRFREIGHT_PER_BOX'); // null
    expect(codes).not.toContain('AIRFREIGHT_STORAGE'); // zero
    expect(codes).toContain('AIRFREIGHT_DAMAGE');
  });
});
