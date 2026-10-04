'use strict';

/**
 * Air freight operational reports (Phase 8). Read-only aggregates over the data
 * the earlier phases already capture — nothing new is stored. Kept deliberately
 * small: a handful of figures the hub and the admin actually ask for.
 */

const { prisma } = require('../lib/prisma');

const HOUR = 3_600_000;

/** Boxes physically at the hub (received, not yet handed over) older than 24h. */
const boxesAtHub = async () => {
  const cutoff = new Date(Date.now() - 24 * HOUR);
  const rows = await prisma.airFreightBox.findMany({
    where: { status: { in: ['RECEIVED', 'ON_HOLD'] }, receivedAt: { lt: cutoff } },
    select: { id: true, trackingNumber: true, receivedAt: true, flight: { select: { reference: true } }, courier: { select: { code: true } } },
    orderBy: { receivedAt: 'asc' },
    take: 500,
  });
  return rows.map((b) => ({
    trackingNumber: b.trackingNumber,
    flightReference: b.flight?.reference,
    courierCode: b.courier?.code,
    hoursAtHub: Math.floor((Date.now() - new Date(b.receivedAt).getTime()) / HOUR),
  }));
};

/** Landing → completion hours for each completed flight (last 90 days). */
const throughput = async () => {
  const since = new Date(Date.now() - 90 * 24 * HOUR);
  const flights = await prisma.airFreightFlight.findMany({
    where: { status: 'COMPLETED', completedAt: { gte: since }, landedAt: { not: null } },
    select: { reference: true, landedAt: true, completedAt: true, clientId: true },
    orderBy: { completedAt: 'desc' },
    take: 200,
  });
  return flights.map((f) => ({
    reference: f.reference,
    landingToHandoverHours: Math.round(((new Date(f.completedAt).getTime() - new Date(f.landedAt).getTime()) / HOUR) * 10) / 10,
  }));
};

/** Boxes handed to each courier in the last 7 days. */
const volumeByCourier = async () => {
  const since = new Date(Date.now() - 7 * 24 * HOUR);
  const grouped = await prisma.airFreightBox.groupBy({
    by: ['courierId'],
    where: { status: 'HANDED_TO_COURIER', handedOverAt: { gte: since } },
    _count: { _all: true },
  });
  const couriers = await prisma.courier.findMany({ where: { id: { in: grouped.map((g) => g.courierId) } }, select: { id: true, code: true } });
  const byId = new Map(couriers.map((c) => [c.id, c.code]));
  return grouped.map((g) => ({ courierCode: byId.get(g.courierId) ?? '—', boxes: g._count._all }));
};

/** Open exceptions grouped by age bucket. */
const openExceptionsByAge = async () => {
  const open = await prisma.airFreightException.findMany({
    where: { status: { in: ['OPEN', 'AWAITING_CLIENT'] } }, select: { raisedAt: true },
  });
  const now = Date.now();
  const buckets = { under24h: 0, h24to48: 0, over48h: 0 };
  for (const e of open) {
    const ageH = (now - new Date(e.raisedAt).getTime()) / HOUR;
    if (ageH < 24) buckets.under24h += 1;
    else if (ageH < 48) buckets.h24to48 += 1;
    else buckets.over48h += 1;
  }
  return buckets;
};

const overview = async () => {
  const [atHub, flights, byCourier, exceptions] = await Promise.all([
    boxesAtHub(), throughput(), volumeByCourier(), openExceptionsByAge(),
  ]);
  return { boxesAtHub: atHub, throughput: flights, volumeByCourier: byCourier, openExceptionsByAge: exceptions };
};

module.exports = { overview, boxesAtHub, throughput, volumeByCourier, openExceptionsByAge };
