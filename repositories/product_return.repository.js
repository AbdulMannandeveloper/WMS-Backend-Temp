'use strict';

const { prisma } = require('../lib/prisma');

const db = (tx) => tx || prisma;

const includeRelations = {
  client: { select: { id: true, companyName: true } },
  product: { select: { id: true, skuCode: true, productName: true, barcode: true } },
  shipment: { select: { id: true, reference: true } },
  restockLocation: { select: { id: true, locationName: true, materializedPath: true } },
  // What this return has cost the client so far. Followed by the backlink, so a
  // line an admin later edits or removes on the invoice is reflected here too.
  invoiceLines: {
    select: {
      id: true,
      invoiceId: true,
      description: true,
      quantity: true,
      unitPrice: true,
      totalPrice: true,
      dateOfService: true,
    },
    orderBy: { dateOfService: 'asc' },
  },
};

const createReturn = async (data, tx) =>
  await db(tx).productReturn.create({ data, include: includeRelations });

const getReturnById = async (id, tx) =>
  await db(tx).productReturn.findUnique({ where: { id }, include: includeRelations });

const getReturns = async ({ status } = {}, tx) =>
  await db(tx).productReturn.findMany({
    where: status ? { status } : undefined,
    include: includeRelations,
    orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
  });

/**
 * The most recent references in a series (e.g. "RET-2026-"), highest first, for
 * the sequence generator. Mirrors shipment.repository.getLatestReferencesInSeries.
 */
const getLatestReferencesInSeries = async (prefix, take, tx) =>
  await db(tx).productReturn.findMany({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: 'desc' },
    select: { reference: true },
    take,
  });

/**
 * Moves a return out of RECORDED, only if it is still there.
 *
 * Conditional rather than read-then-write, so two people resolving the same
 * return at once cannot both succeed — one would restock it and the other
 * dispose of it, and the shelf and the invoice would each believe a different
 * story. Returns the number of rows moved: 0 means someone got there first.
 */
const resolveIfOpen = async (id, data, tx) => {
  const { count } = await db(tx).productReturn.updateMany({
    where: { id, status: 'RECORDED' },
    data,
  });
  return count;
};

/**
 * Dispatched outbound shipments carrying this courier number, on the shipment
 * or on any of its lines, most recent first.
 *
 * Several can come back: couriers do recycle numbers eventually, and a line
 * sent separately carries its own. The caller decides what a match means.
 */
const findDispatchedShipmentsByTracking = async (trackingNumber, tx) =>
  await db(tx).shipment.findMany({
    where: {
      status: 'DISPATCHED',
      OR: [
        { trackingId: trackingNumber },
        { shipmentItems: { some: { trackingId: trackingNumber } } },
      ],
    },
    select: {
      id: true,
      reference: true,
      clientId: true,
      createdAt: true,
      client: { select: { id: true, companyName: true } },
      shipmentItems: {
        select: {
          id: true,
          productId: true,
          quantity: true,
          returnedQuantity: true,
          sourceLocationId: true,
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 10,
  });

/**
 * Counts `amount` more units of a shipment line as having come back — only if
 * that leaves the line no more returned than it shipped.
 *
 * One conditional statement, because the check and the write have to be the
 * same act: two returns booked against the last three units at the same moment
 * must not both fit. Prisma cannot compare two columns in a where clause, so
 * this is raw. Returns 0 when it would overrun.
 */
const addReturnedQuantity = async (shipmentItemId, amount, tx) =>
  await db(tx).$executeRaw`
    UPDATE shipment_items
    SET returned_quantity = returned_quantity + ${amount}
    WHERE id = ${shipmentItemId}::uuid
      AND returned_quantity + ${amount} <= quantity
  `;

module.exports = {
  createReturn,
  getReturnById,
  getReturns,
  getLatestReferencesInSeries,
  resolveIfOpen,
  findDispatchedShipmentsByTracking,
  addReturnedQuantity,
};
