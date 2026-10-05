'use strict';

const path = require('path');

const freightLogic = require('../logic/freight_shipment.logic');
const { dependentsBody } = require('../utils/dependents');
const { pick } = require('../utils/pick');
const { paginatedResponse } = require('../utils/pagination');
const { buildListQuery } = require('../utils/queryFilters');
const { listError } = require('../utils/listResponse');
const {
  uploadBuffer,
  getObjectStream,
  objectExists,
} = require('../lib/objectStorage');

/**
 * What a caller may set.
 *
 * `reference`, `barcode`, `status` and every *ByUserId are absent on purpose: the
 * first two are issued by the logic, the third moves only through the dispatch,
 * receive and cancel actions, and the last come from the session. A body naming
 * any of them is a body rewriting the audit trail.
 */
const FREIGHT_CREATE_FIELDS = [
  'senderName',
  'senderContact',
  'senderAddress',
  'receiverName',
  'receiverContact',
  'receiverAddress',
  'destinationCountry',
  'description',
  'quantity',
  'weight',
  'weightUnit',
  'remarks',
];

/** An edit may touch the same fields, and no more. */
const FREIGHT_UPDATE_FIELDS = FREIGHT_CREATE_FIELDS;

const FREIGHT_RECEIVE_FIELDS = ['barcode', 'actualWeight', 'actualWeightUnit', 'remarks'];

const actor = (req) => req.user && req.user.id;

/**
 * The one error mapping for this module.
 *
 * `err.status` where the logic set one — 404 for a missing shipment, 409 for a
 * parcel already received, which the bench screen distinguishes — and 400
 * otherwise, because everything else thrown from the logic is the caller having
 * asked for something the rules do not allow.
 */
const fail = (res, error) => {
  // Something still depends on it: the 409 carries what, for the warning.
  if (error.code === 'HAS_DEPENDENTS') return res.status(409).json(dependentsBody(error));
  const status = error.status || (/not found/i.test(error.message) ? 404 : 400);
  const body = { error: error.message };
  // The already-received refusal carries the shipment so the screen can name who
  // received it and when without a second round trip.
  if (error.shipment) body.shipment = error.shipment;
  return res.status(status).json(body);
};

// ─── Shipments ────────────────────────────────────────────────────────────────

const createFreightShipment = async (req, res) => {
  try {
    const data = pick(req.body, FREIGHT_CREATE_FIELDS);
    // The creator comes from the session, never the body.
    const created = await freightLogic.createFreightShipment(data, actor(req));
    return res.status(201).json(created);
  } catch (error) {
    return fail(res, error);
  }
};

const getAllFreightShipments = async (req, res) => {
  try {
    const { where, orderBy, pagination } = buildListQuery(
      req.query,
      freightLogic.FREIGHT_SHIPMENT_LIST_SPEC,
    );
    const result = await freightLogic.getAllFreightShipments(where, { orderBy, pagination });
    return res.status(200).json(paginatedResponse(result.items, result.total, pagination));
  } catch (err) {
    return listError(res, err, 'getAllFreightShipments');
  }
};

/**
 * Totals for the cards above the table.
 *
 * Builds its `where` from the same spec and the same req.query as the list, so
 * the counts cannot describe a different set of rows from the ones shown.
 */
const getFreightShipmentSummary = async (req, res) => {
  try {
    const { where } = buildListQuery(req.query, freightLogic.FREIGHT_SHIPMENT_LIST_SPEC);
    const summary = await freightLogic.summariseFreightShipments(where);
    return res.status(200).json(summary);
  } catch (err) {
    return listError(res, err, 'getFreightShipmentSummary');
  }
};

const getFreightShipment = async (req, res) => {
  try {
    const shipment = await freightLogic.getFreightShipmentById(req.params.id);
    return res.status(200).json(shipment);
  } catch (error) {
    return fail(res, error);
  }
};

const getFreightShipmentHistory = async (req, res) => {
  try {
    const history = await freightLogic.getFreightShipmentHistory(req.params.id);
    return res.status(200).json(history);
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * What a scanned code belongs to.
 *
 * 404 when nothing matches, which is the bench's "Shipment Not Found" screen. An
 * unrecognised code is an answer rather than a fault, so this does not log.
 */
const lookupFreightShipmentByBarcode = async (req, res) => {
  try {
    const { shipment, matchedOn } = await freightLogic.lookupByBarcode(req.params.value);
    if (!shipment) {
      return res
        .status(404)
        .json({ error: 'No shipment is associated with this barcode.' });
    }
    return res.status(200).json({ shipment, matchedOn });
  } catch (error) {
    return fail(res, error);
  }
};

const updateFreightShipment = async (req, res) => {
  try {
    const data = pick(req.body, FREIGHT_UPDATE_FIELDS);
    const updated = await freightLogic.updateFreightShipment(
      req.params.id,
      data,
      actor(req),
    );
    return res.status(200).json(updated);
  } catch (error) {
    return fail(res, error);
  }
};

const dispatchFreightShipment = async (req, res) => {
  try {
    const dispatched = await freightLogic.dispatchFreightShipment(
      req.params.id,
      actor(req),
    );
    return res.status(200).json(dispatched);
  } catch (error) {
    return fail(res, error);
  }
};

const receiveFreightShipment = async (req, res) => {
  try {
    const data = pick(req.body, FREIGHT_RECEIVE_FIELDS);
    const received = await freightLogic.receiveFreightShipment(
      req.params.id,
      data,
      actor(req),
    );
    return res.status(200).json(received);
  } catch (error) {
    return fail(res, error);
  }
};

const cancelFreightShipment = async (req, res) => {
  try {
    const cancelled = await freightLogic.cancelFreightShipment(req.params.id, actor(req));
    return res.status(200).json(cancelled);
  } catch (error) {
    return fail(res, error);
  }
};

// What a delete would refuse on and what goes with it, asked before pressing it.
const getFreightShipmentDependents = async (req, res) => {
  try {
    const { report } = await freightLogic.getFreightShipmentDependents(req.params.id, undefined, {
      // TESTING-ONLY start
      isAdmin: req.user?.role === 'admin',
      // TESTING-ONLY end
    });
    return res.status(200).json(report);
  } catch (error) {
    return fail(res, error);
  }
};

const deleteFreightShipment = async (req, res) => {
  try {
    const result = await freightLogic.deleteFreightShipment(req.params.id, actor(req), {
      // TESTING-ONLY start
      isAdmin: req.user?.role === 'admin',
      // TESTING-ONLY end
    });
    return res.status(200).json(result);
  } catch (error) {
    return fail(res, error);
  }
};

// ─── Documents ────────────────────────────────────────────────────────────────

/**
 * Stores the uploaded booking receipt and records it against the shipment.
 *
 * The same two steps as the expenses receipt upload: the buffer goes to
 * objectStorage under a generated key, and the original filename is kept in the
 * database so the file is recognisable in a list. The key includes the shipment id
 * so an orphaned object can still be traced back to what it belonged to.
 */
const uploadFreightDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const { id } = req.params;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const storageKey = `freight-${id}-${uniqueSuffix}${ext}`;

    await uploadBuffer(storageKey, req.file.buffer, req.file.mimetype);

    const document = await freightLogic.attachDocument(
      id,
      {
        fileName: req.file.originalname,
        storageKey,
        fileType: req.file.mimetype,
      },
      actor(req),
    );

    return res.status(201).json({
      ...document,
      url: `/api/freight-shipments/documents/${storageKey}`,
    });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * Streams a document back.
 *
 * Through an authenticated route rather than as a static asset: these are
 * customers' booking slips with names and addresses on them, and the uploads
 * directory is not public.
 *
 * The key is checked against the documents table before anything is read, so this
 * route serves freight documents and nothing else that happens to share the
 * bucket.
 */
const getFreightDocument = async (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename || filename !== path.basename(filename)) {
      return res.status(400).json({ error: 'Invalid file name.' });
    }

    const document = await freightLogic.documentForStorageKey(filename);
    if (!document) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    const exists = await objectExists(filename);
    if (!exists) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    const { stream, contentType } = await getObjectStream(filename);
    // The local storage backend reports no content type — it only has a path on
    // disk — so the type recorded at upload is the fallback. Without it the
    // browser guesses, and a PDF served as octet-stream downloads instead of
    // opening, which is the opposite of what the detail page wants.
    const served = contentType || document.fileType;
    if (served) {
      res.setHeader('Content-Type', served);
    }
    // inline rather than attachment: the detail page shows the slip, and a
    // download prompt for every glance at a receipt is a click nobody wants.
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${document.fileName.replace(/"/g, '')}"`,
    );
    return stream.pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Document not found.' });
    }
    return res.status(400).json({ error: err.message });
  }
};

const removeFreightDocument = async (req, res) => {
  try {
    const result = await freightLogic.removeDocument(
      req.params.id,
      req.params.documentId,
      actor(req),
    );
    return res.status(200).json(result);
  } catch (error) {
    return fail(res, error);
  }
};

module.exports = {
  createFreightShipment,
  getAllFreightShipments,
  getFreightShipmentSummary,
  getFreightShipment,
  getFreightShipmentHistory,
  lookupFreightShipmentByBarcode,
  updateFreightShipment,
  dispatchFreightShipment,
  receiveFreightShipment,
  cancelFreightShipment,
  deleteFreightShipment,
  getFreightShipmentDependents,
  uploadFreightDocument,
  getFreightDocument,
  removeFreightDocument,
};
