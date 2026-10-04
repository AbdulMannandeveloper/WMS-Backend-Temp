'use strict';

/**
 * The air freight pricing engine — pure, no database (§5 of the plan).
 *
 * Every price is the client's agreed rate; a missing rate or a rate of 0 omits
 * that line (the module never invents a price). All weight maths is done in
 * integer grams and millimetres to avoid float drift, then divided back to kg at
 * the end. A box is billed when it was received at the hub and is not written off
 * or cancelled — damaged-but-shipped, returned and over boxes added to the
 * manifest all count; a short box that never arrived does not.
 */

const round2 = (x) => Number(x.toFixed(2));

/** A positive integer, or 0. Used to fold a Decimal-as-number into grams/mm. */
const gramsFromKg = (kg) => Math.round(1000 * Number(kg || 0));
const mmFromCm = (cm) => Math.round(10 * Number(cm || 0));

const BILLABLE = (b) => b.receivedAt != null && b.status !== 'WRITTEN_OFF' && b.status !== 'CANCELLED';

/**
 * @param {object} args
 * @param {Array} args.boxes
 * @param {Array} args.exceptions  [{type, resolution, chargeable, boxId}]
 * @param {object} args.rates  { perKg, perBox, storage, damage, relabel } each {unitPrice:number}|null
 * @param {object} args.settings  { method, divisor, roundingIncrementKg, freeStorageHours }
 * @param {Date}   args.now  posting time, for storage of boxes still at the hub
 * @returns {{ lines: object[], totals: {chargeableKg:number, billedBoxes:number, storageBoxDays:number, total:number}, breakdown: object[] }}
 */
const calculateFlightCharges = ({ boxes = [], exceptions = [], rates = {}, settings = {}, now = new Date() }) => {
  const divisor = Number(settings.divisor) || 6000;
  const incG = Math.round((Number(settings.roundingIncrementKg) || 0) * 1000);
  const freeHours = Number(settings.freeStorageHours) || 0;
  const method = settings.method === 'FLIGHT_TOTAL' ? 'FLIGHT_TOTAL' : 'PER_BOX';

  const roundUpG = (g) => (incG > 0 ? Math.ceil(g / incG) * incG : Math.ceil(g / 10) * 10);

  const billed = boxes.filter(BILLABLE);

  const actualG = (b) => gramsFromKg(b.measuredWeightKg ?? b.declaredWeightKg);
  const volG = (b) => {
    const L = mmFromCm(b.measuredLengthCm ?? b.lengthCm);
    const W = mmFromCm(b.measuredWidthCm ?? b.widthCm);
    const H = mmFromCm(b.measuredHeightCm ?? b.heightCm);
    return Math.ceil((L * W * H) / divisor);
  };

  let chargeableG;
  if (method === 'FLIGHT_TOTAL') {
    const sumActual = billed.reduce((n, b) => n + actualG(b), 0);
    const sumVol = billed.reduce((n, b) => n + volG(b), 0);
    chargeableG = roundUpG(Math.max(sumActual, sumVol));
  } else {
    chargeableG = billed.reduce((n, b) => n + roundUpG(Math.max(actualG(b), volG(b))), 0);
  }
  const chargeableKg = round2(chargeableG / 1000);

  // Storage box-days: per billed box, time at the hub beyond the free window.
  let storageBoxDays = 0;
  for (const b of billed) {
    const start = b.receivedAt ? new Date(b.receivedAt).getTime() : null;
    if (start == null) continue;
    const end = (b.handedOverAt ? new Date(b.handedOverAt) : b.returnedAt ? new Date(b.returnedAt) : now).getTime();
    const hours = (end - start) / 3_600_000;
    const over = hours - freeHours;
    if (over > 0) storageBoxDays += Math.ceil(over / 24);
  }

  const billedIds = new Set(billed.map((b) => b.id));
  const damageQty = exceptions.filter((e) => e.type === 'DAMAGED' && e.chargeable && (!e.boxId || billedIds.has(e.boxId))).length;
  const relabelQty = exceptions.filter((e) => e.resolution === 'RELABELLED' && e.chargeable && (!e.boxId || billedIds.has(e.boxId))).length;

  const rate = (r) => (r && Number(r.unitPrice) > 0 ? Number(r.unitPrice) : null);
  const lines = [];
  const addLine = (code, label, qty, unitPrice, unit) => {
    const price = rate(unitPrice);
    if (!price || qty <= 0) return;
    lines.push({
      code,
      label,
      quantity: round2(qty),
      unit,
      unitPrice: price,
      total: round2(qty * price),
      formula: `${round2(qty)} ${unit} × £${price.toFixed(2)}`,
    });
  };

  addLine('AIRFREIGHT_PER_KG', 'Air freight (per chargeable kg)', chargeableKg, rates.perKg, 'kg');
  addLine('AIRFREIGHT_PER_BOX', 'Air freight handling (per box)', billed.length, rates.perBox, 'box');
  addLine('AIRFREIGHT_STORAGE', 'Air freight storage (per box-day)', storageBoxDays, rates.storage, 'box-day');
  addLine('AIRFREIGHT_DAMAGE', 'Damaged box handling', damageQty, rates.damage, 'box');
  addLine('AIRFREIGHT_RELABEL', 'Box relabelling', relabelQty, rates.relabel, 'box');

  // Per-client-reference breakdown, for the CSV/PDF.
  const groups = new Map();
  for (const b of billed) {
    const key = b.clientReference || '—';
    const g = groups.get(key) || { clientReference: key, boxes: 0, chargeableKg: 0, storageBoxDays: 0 };
    g.boxes += 1;
    g.chargeableKg += roundUpG(Math.max(actualG(b), volG(b))) / 1000;
    groups.set(key, g);
  }
  const breakdown = [...groups.values()].map((g) => ({ ...g, chargeableKg: round2(g.chargeableKg) }));

  const total = round2(lines.reduce((n, l) => n + l.total, 0));

  return {
    lines,
    totals: { chargeableKg, billedBoxes: billed.length, storageBoxDays, total },
    breakdown,
    method,
  };
};

module.exports = { calculateFlightCharges, round2 };
