'use strict';

/**
 * The air freight module's HTTP layer: flights, manifests, boxes and the
 * per-client settings. Grows with later phases (receiving, handovers,
 * exceptions, billing), which may split into sibling controllers.
 *
 * Two rules hold across every handler here:
 *   - scope() resolves the client a request is limited to (the client's own id
 *     in the portal, null for staff), and every read and write passes it down so
 *     a client can never reach another client's flight — cross-tenant answers 404.
 *   - send() runs every client-facing response through redactForClient, so
 *     internal notes, who-did-what and billing never leave the building.
 */

const settingsLogic = require('../logic/air_freight_settings.logic');
const flightLogic = require('../logic/air_freight_flight.logic');
const manifestLogic = require('../logic/air_freight_manifest.logic');
const boxLogic = require('../logic/air_freight_box.logic');
const { pick } = require('../utils/pick');
const { paginatedResponse, parsePagination } = require('../utils/pagination');
const { listByFlight: listEventsByFlight } = require('../repositories/air_freight_event.repository');
const { listError } = require('../utils/listResponse');
const { dependentsBody } = require('../utils/dependents');
const { resolveOwnClientId } = require('../utils/clientScope');
const { redactForClient } = require('../utils/airFreightRedact');
const { getObjectStream } = require('../lib/objectStorage');
const { toCsv } = require('../utils/csvExport');

const SETTINGS_FIELDS = [
  'chargeableWeightMethod',
  'volumetricDivisor',
  'roundingIncrementKg',
  'freeStorageHours',
  'emailNotifications',
  'notificationEmail',
];

const FLIGHT_FIELDS = [
  'originLocation', 'destinationLocation', 'mawbNumber', 'airline', 'flightNumber',
  'etd', 'eta', 'declaredPieces', 'declaredWeightKg', 'notes',
];

const fail = (res, error) => {
  const status = error.status || (/not found/i.test(error.message) ? 404 : 400);
  return res.status(status).json({ error: error.message });
};

const actor = (req) => req.user && req.user.id;
const isClient = (req) => req.user && req.user.role === 'client';

/** The client a request is limited to (null for staff). */
const scope = (req) => resolveOwnClientId(req.user);

/** Every client-facing response is redacted; staff see the full row. */
const send = (req, res, status, data) =>
  res.status(status).json(isClient(req) ? redactForClient(data) : data);

// ─── Settings (admin only; not redacted — admin only reaches it) ────────────────

const getClientSettings = async (req, res) => {
  try {
    return res.status(200).json(await settingsLogic.getSettings(req.params.clientId));
  } catch (error) {
    return fail(res, error);
  }
};

const updateClientSettings = async (req, res) => {
  try {
    const data = pick(req.body, SETTINGS_FIELDS);
    return res
      .status(200)
      .json(await settingsLogic.updateSettings(req.params.clientId, data, actor(req)));
  } catch (error) {
    return fail(res, error);
  }
};

// ─── Flights ─────────────────────────────────────────────────────────────────

const listFlights = async (req, res) => {
  try {
    const scopeClientId = await scope(req);
    const { items, total } = await flightLogic.listFlights(req.query, scopeClientId);
    const pagination = parsePagination(req.query);
    return res.status(200).json({
      data: isClient(req) ? redactForClient(items) : items,
      pagination: paginatedResponse(items, total, pagination).pagination,
    });
  } catch (err) {
    return listError(res, err, 'listAirFreightFlights');
  }
};

const summariseFlights = async (req, res) => {
  try {
    const scopeClientId = await scope(req);
    return res.status(200).json(await flightLogic.summariseFlights(req.query, scopeClientId));
  } catch (err) {
    return listError(res, err, 'summariseAirFreightFlights');
  }
};

const createFlight = async (req, res) => {
  try {
    // A client's flight is always their own — whatever clientId they send is
    // ignored, not refused. Staff name the client.
    const ownClientId = await scope(req);
    const clientId = ownClientId ?? req.body?.clientId;
    const data = { ...pick(req.body, FLIGHT_FIELDS), clientId };
    send(req, res, 201, await flightLogic.createFlight(data, actor(req)));
  } catch (err) {
    fail(res, err);
  }
};

const getFlight = async (req, res) => {
  try {
    send(req, res, 200, await flightLogic.getFlight(req.params.id, await scope(req)));
  } catch (err) {
    fail(res, err);
  }
};

const updateFlight = async (req, res) => {
  try {
    const data = pick(req.body, FLIGHT_FIELDS);
    send(
      req,
      res,
      200,
      await flightLogic.updateFlight(req.params.id, data, actor(req), {
        afterDispatchReason: req.body?.reason,
        actorRole: req.user?.role,
      }),
    );
  } catch (err) {
    fail(res, err);
  }
};

const getFlightDependents = async (req, res) => {
  try {
    const { report } = await flightLogic.getFlightDependents(req.params.id, await scope(req));
    res.status(200).json(report);
  } catch (err) {
    fail(res, err);
  }
};

const deleteFlight = async (req, res) => {
  try {
    res.status(200).json(await flightLogic.deleteFlight(req.params.id, await scope(req), actor(req)));
  } catch (err) {
    if (err.code === 'HAS_DEPENDENTS') return res.status(409).json(dependentsBody(err));
    fail(res, err);
  }
};

const cancelFlight = async (req, res) => {
  try {
    send(req, res, 200, await flightLogic.cancelFlight(req.params.id, req.body?.reason, actor(req)));
  } catch (err) {
    fail(res, err);
  }
};

const dispatchFlight = async (req, res) => {
  try {
    // A client may dispatch their own flight; scope-check before the action.
    const scopeClientId = await scope(req);
    if (scopeClientId) await flightLogic.getFlight(req.params.id, scopeClientId);
    send(req, res, 200, await flightLogic.dispatchFlight(req.params.id, actor(req)));
  } catch (err) {
    fail(res, err);
  }
};

const flightEvents = async (req, res) => {
  try {
    const scopeClientId = await scope(req);
    // A scope check via getFlight (404 cross-tenant) before listing its events.
    await flightLogic.getFlight(req.params.id, scopeClientId);
    const pagination = parsePagination(req.query);
    const { items, total } = await listEventsByFlight(req.params.id, { pagination });
    return res.status(200).json({
      data: isClient(req) ? redactForClient(items) : items,
      pagination: paginatedResponse(items, total, pagination).pagination,
    });
  } catch (err) {
    fail(res, err);
  }
};

const flightManifestCsv = async (req, res) => {
  try {
    const scopeClientId = await scope(req);
    const flight = await flightLogic.getFlight(req.params.id, scopeClientId);
    const boxes = await boxLogic.boxesForExport(req.params.id, scopeClientId);
    const headers = [
      'tracking_number', 'courier', 'status', 'client_reference', 'reference',
      'weight_kg', 'length_cm', 'width_cm', 'height_cm',
      'contents_description', 'declared_value', 'currency', 'consignee_name', 'consignee_postcode',
    ];
    const rows = boxes.map((b) => [
      b.trackingNumber, b.courier?.code ?? '', b.status, b.clientReference ?? '', b.reference ?? '',
      Number(b.measuredWeightKg ?? b.declaredWeightKg), Number(b.lengthCm), Number(b.widthCm), Number(b.heightCm),
      b.contentsDescription, Number(b.declaredValue), b.currency, b.consigneeName, b.consigneePostcode,
    ]);
    const csv = toCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="manifest-${flight.reference}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    fail(res, err);
  }
};

// ─── Manifests ──────────────────────────────────────────────────────────────

const listUploads = async (req, res) => {
  try {
    send(req, res, 200, await manifestLogic.listUploads(req.params.id, await scope(req)));
  } catch (err) {
    fail(res, err);
  }
};

const previewUpload = async (req, res) => {
  try {
    send(
      req,
      res,
      201,
      await manifestLogic.previewUpload(req.params.id, req.file, req.body?.mode, actor(req), await scope(req)),
    );
  } catch (err) {
    fail(res, err);
  }
};

const commitUpload = async (req, res) => {
  try {
    send(
      req,
      res,
      200,
      await manifestLogic.commitUpload(req.params.id, req.params.uploadId, actor(req), await scope(req)),
    );
  } catch (err) {
    fail(res, err);
  }
};

const discardUpload = async (req, res) => {
  try {
    send(
      req,
      res,
      200,
      await manifestLogic.discardUpload(req.params.id, req.params.uploadId, actor(req), await scope(req)),
    );
  } catch (err) {
    fail(res, err);
  }
};

const getUploadFile = async (req, res) => {
  try {
    const upload = await manifestLogic.getUploadForFile(req.params.uploadId, await scope(req));
    const { stream, contentType } = await getObjectStream(upload.storageKey);
    res.setHeader('Content-Type', upload.fileType || contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${upload.fileName}"`);
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found.' });
    fail(res, err);
  }
};

const manifestTemplate = async (req, res) => {
  try {
    const { buffer, fileName, contentType } = await manifestLogic.renderTemplate(req.query.format);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.status(200).send(buffer);
  } catch (err) {
    fail(res, err);
  }
};

// ─── Boxes ──────────────────────────────────────────────────────────────────

const listBoxes = async (req, res) => {
  try {
    const scopeClientId = await scope(req);
    const { items, total } = await boxLogic.listBoxes(req.query, scopeClientId);
    const pagination = parsePagination(req.query);
    return res.status(200).json({
      data: isClient(req) ? redactForClient(items) : items,
      pagination: paginatedResponse(items, total, pagination).pagination,
    });
  } catch (err) {
    return listError(res, err, 'listAirFreightBoxes');
  }
};

const getBox = async (req, res) => {
  try {
    send(req, res, 200, await boxLogic.getBox(req.params.id, await scope(req)));
  } catch (err) {
    fail(res, err);
  }
};

const bulkSearchBoxes = async (req, res) => {
  try {
    send(
      req,
      res,
      200,
      await boxLogic.bulkSearch(req.body?.trackingNumbers, await scope(req)),
    );
  } catch (err) {
    fail(res, err);
  }
};

module.exports = {
  getClientSettings,
  updateClientSettings,
  listFlights,
  summariseFlights,
  createFlight,
  getFlight,
  updateFlight,
  getFlightDependents,
  deleteFlight,
  cancelFlight,
  dispatchFlight,
  flightEvents,
  flightManifestCsv,
  listUploads,
  previewUpload,
  commitUpload,
  discardUpload,
  getUploadFile,
  manifestTemplate,
  listBoxes,
  getBox,
  bulkSearchBoxes,
};
