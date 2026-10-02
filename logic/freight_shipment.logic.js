'use strict';

const { prisma } = require('../lib/prisma');
const freightRepository = require('../repositories/freight_shipment.repository');
const auditLogLogic = require('./audit_log.logic');
const { buildReport, assertDeletable } = require('../utils/dependents');
const {
  dateRangeFilter,
  parseEnum,
  parseString,
  searchFilter,
} = require('../utils/queryFilters');

/**
 * The freight lifecycle, enforced here rather than in the browser.
 *
 * BOOKED → DISPATCHED → RECEIVED, and CANCELLED from either of the first two.
 * RECEIVED and CANCELLED are terminal — there is no un-receiving a parcel that
 * is standing on the UK floor, and a shipment cancelled in Pakistan has nothing
 * to arrive.
 *
 * A parcel cannot be received straight from BOOKED. That is not pedantry: a
 * BOOKED shipment is one still sitting in the Pakistan shop, so a barcode
 * scanning as BOOKED at the UK bench means either the label was reused or the
 * dispatch was never recorded, and both are worth stopping to look at.
 */
const FREIGHT_TRANSITIONS = {
  BOOKED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [],
  CANCELLED: [],
};

const FREIGHT_STATUSES = Object.keys(FREIGHT_TRANSITIONS);

const WEIGHT_UNITS = ['KG', 'LB'];

const assertTransition = (from, to) => {
  const allowed = FREIGHT_TRANSITIONS[from];
  if (!allowed) {
    throw new Error(`Freight shipment has an unrecognised status: ${from}.`);
  }
  if (!allowed.includes(to)) {
    const options = allowed.length
      ? allowed.join(', ')
      : 'nothing — it is a final state';
    throw new Error(
      `A ${from} freight shipment cannot become ${to}. Allowed from ${from}: ${options}.`,
    );
  }
};

/** Loads a shipment or throws. Shared by every transition below. */
const requireShipment = async (id, tx) => {
  const shipment = await freightRepository.getFreightShipmentByField('id', id, tx);
  if (!shipment) {
    const error = new Error('Freight shipment not found.');
    error.status = 404;
    throw error;
  }
  return shipment;
};

/** Audit failures must never roll back the operation they describe. */
const audit = (actorUserId, action, details) => {
  if (!actorUserId) return Promise.resolve(null);
  return auditLogLogic
    .createAuditLog(actorUserId, action, details)
    .catch((err) => console.error(`Audit log error (${action}):`, err.message));
};

/* ── Validation ───────────────────────────────────────────────────────────────
 *
 * Hand-written, in the shape the rest of the backend uses: an operator-readable
 * sentence per rule, thrown from here rather than checked in the controller, so
 * a shipment created by a test, by the React form or by curl obeys the same
 * rules.
 */

const TEXT_LIMITS = {
  senderName: 160,
  senderContact: 40,
  receiverName: 160,
  receiverContact: 40,
  destinationCountry: 80,
};

/** Reads as a phone number, permissively. */
const CONTACT_PATTERN = /^[0-9+()\-\s]+$/;

const LABELS = {
  senderName: "Sender's name",
  senderContact: "Sender's contact number",
  senderAddress: "Sender's address",
  receiverName: "Receiver's name",
  receiverContact: "Receiver's contact number",
  receiverAddress: "Receiver's address",
  destinationCountry: 'Destination country',
  description: 'Shipment description',
};

const normaliseText = (raw, field, { required = true } = {}) => {
  if (raw === undefined || raw === null) {
    if (required) throw new Error(`${LABELS[field] || field} is required.`);
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new Error(`${LABELS[field] || field} must be text.`);
  }

  const cleaned = raw.trim();
  if (cleaned === '') {
    if (required) throw new Error(`${LABELS[field] || field} is required.`);
    return null;
  }

  const limit = TEXT_LIMITS[field];
  if (limit && cleaned.length > limit) {
    throw new Error(
      `${LABELS[field] || field} is too long — ${limit} characters maximum.`,
    );
  }
  return cleaned;
};

/**
 * A contact number, trimmed but otherwise as typed.
 *
 * Deliberately not stripped down to digits. These are Pakistani and British
 * numbers written by whoever took the booking, and a number reformatted by us is
 * a number the sender does not recognise when they are read it back.
 */
const normaliseContact = (raw, field) => {
  const cleaned = normaliseText(raw, field);
  if (cleaned && !CONTACT_PATTERN.test(cleaned)) {
    throw new Error(
      `${LABELS[field]} may contain only digits, spaces and the characters + - ( ).`,
    );
  }
  return cleaned;
};

const normaliseQuantity = (raw) => {
  const quantity = Number(raw);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('Quantity must be a whole number above zero.');
  }
  return quantity;
};

/**
 * A weight, returned as a **string**.
 *
 * Prisma takes a string for a Decimal column and keeps every digit of it. Passing
 * the parsed Number instead would hand a float to a DECIMAL(10,3) and quietly
 * round the third decimal place on a parcel weighed to the gram.
 */
const normaliseWeight = (raw, { label = 'Weight' } = {}) => {
  if (raw === undefined || raw === null || raw === '') {
    throw new Error(`${label} is required.`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a number above zero.`);
  }
  if (value > 9_999_999) {
    throw new Error(`${label} is implausibly large — check the unit.`);
  }
  return String(raw).trim();
};

const normaliseWeightUnit = (raw, { required = true } = {}) => {
  if (raw === undefined || raw === null || raw === '') {
    return required ? 'KG' : undefined;
  }
  const unit = String(raw).trim().toUpperCase();
  if (!WEIGHT_UNITS.includes(unit)) {
    throw new Error(`Weight unit must be one of: ${WEIGHT_UNITS.join(', ')}.`);
  }
  return unit;
};

/** Every field of a shipment, validated together. Used by create. */
const normaliseShipmentInput = (data) => ({
  senderName: normaliseText(data.senderName, 'senderName'),
  senderContact: normaliseContact(data.senderContact, 'senderContact'),
  senderAddress: normaliseText(data.senderAddress, 'senderAddress'),
  receiverName: normaliseText(data.receiverName, 'receiverName'),
  receiverContact: normaliseContact(data.receiverContact, 'receiverContact'),
  receiverAddress: normaliseText(data.receiverAddress, 'receiverAddress'),
  destinationCountry: normaliseText(data.destinationCountry, 'destinationCountry'),
  description: normaliseText(data.description, 'description'),
  quantity: normaliseQuantity(data.quantity),
  weight: normaliseWeight(data.weight),
  weightUnit: normaliseWeightUnit(data.weightUnit),
  remarks: normaliseText(data.remarks, 'remarks', { required: false }) ?? null,
});

/**
 * Only the fields the caller actually sent, validated.
 *
 * An edit that names three fields must not be made to supply the other nine —
 * and must not be allowed to blank them by omission either, which is why this
 * skips absent keys rather than defaulting them.
 */
const normalisePatch = (data) => {
  const patch = {};
  const put = (field, value) => {
    if (value !== undefined) patch[field] = value;
  };

  if ('senderName' in data) put('senderName', normaliseText(data.senderName, 'senderName'));
  if ('senderContact' in data)
    put('senderContact', normaliseContact(data.senderContact, 'senderContact'));
  if ('senderAddress' in data)
    put('senderAddress', normaliseText(data.senderAddress, 'senderAddress'));
  if ('receiverName' in data)
    put('receiverName', normaliseText(data.receiverName, 'receiverName'));
  if ('receiverContact' in data)
    put('receiverContact', normaliseContact(data.receiverContact, 'receiverContact'));
  if ('receiverAddress' in data)
    put('receiverAddress', normaliseText(data.receiverAddress, 'receiverAddress'));
  if ('destinationCountry' in data)
    put('destinationCountry', normaliseText(data.destinationCountry, 'destinationCountry'));
  if ('description' in data)
    put('description', normaliseText(data.description, 'description'));
  if ('quantity' in data) put('quantity', normaliseQuantity(data.quantity));
  if ('weight' in data) put('weight', normaliseWeight(data.weight));
  if ('weightUnit' in data) put('weightUnit', normaliseWeightUnit(data.weightUnit));
  if ('remarks' in data)
    patch.remarks = normaliseText(data.remarks, 'remarks', { required: false }) ?? null;

  if (Object.keys(patch).length === 0) {
    throw new Error('Nothing to update.');
  }
  return patch;
};

/* ── The shipment reference ───────────────────────────────────────────────────
 *
 * Issued here, not typed in. The same scheme the outbound shipments use, with a
 * prefix of its own: FRT-<year>-<sequence>, e.g. FRT-2026-000123. SHP- was not
 * available — shipments.reference already holds it, and one prefix answering to
 * two tables is a search box that returns the wrong parcel.
 *
 * The year scopes the sequence so it restarts each January and stays short enough
 * to read down a phone line. The sequence is zero-padded to a fixed width, which
 * is what lets the next number be found with a single indexed "highest so far"
 * read — without the padding, FRT-2026-10000 would sort below FRT-2026-9999.
 */
const REFERENCE_PREFIX = 'FRT';
const REFERENCE_DIGITS = 6;

/** How many times a reference collision is worth retrying before giving up. */
const REFERENCE_ATTEMPTS = 5;

/** How far down the series to look for a reference this scheme wrote. */
const REFERENCE_SCAN = 10;

const referenceSeriesFor = (date) =>
  `${REFERENCE_PREFIX}-${date.getUTCFullYear()}-`;

/**
 * The next reference in this year's series.
 *
 * Takes a transaction so the number it continues from is committed state rather
 * than whatever was true when the request arrived.
 */
const nextReference = async (tx) => {
  const series = referenceSeriesFor(new Date());
  const recent = await freightRepository.getLatestReferencesInSeries(
    series,
    REFERENCE_SCAN,
    tx,
  );

  // The first that parses wins. A reference sharing the prefix but not the shape
  // sorts above the generated ones and would otherwise read as NaN, sending the
  // sequence back to 1 and colliding with the shipment already holding it.
  let last = 0;
  for (const row of recent) {
    const tail = row.reference.slice(series.length);
    if (!/^\d+$/.test(tail)) continue;
    last = Number.parseInt(tail, 10);
    break;
  }

  return `${series}${String(last + 1).padStart(REFERENCE_DIGITS, '0')}`;
};

/**
 * Whether this failure is two bookings having picked the same number.
 *
 * The reference and the barcode carry the same value, so a clash shows on either
 * index. Any other unique violation is a real problem and has to surface rather
 * than be retried into the same failure five times.
 */
const isReferenceClash = (error) => {
  if (error?.code !== 'P2002') return false;
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some((f) => {
    const name = String(f ?? '');
    return name.includes('reference') || name.includes('barcode');
  });
};

/* ── Actor names ──────────────────────────────────────────────────────────────
 *
 * created_by / dispatched_by / cancelled_by / received_by are plain ids with no
 * relations (see the schema), so the names are attached here in one batch read
 * rather than by four joins on every row.
 *
 * The frontend asks "who dispatched this?" and needs a person, not a uuid; there
 * is no `name` column on User, so this is where firstName and lastName are put
 * together — once, rather than in every page that displays a shipment.
 */
const displayName = (user) =>
  user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email : null;

const hydrateActors = async (rows) => {
  const list = Array.isArray(rows) ? rows : [rows];
  const ids = list.flatMap((row) =>
    row
      ? [
          row.createdByUserId,
          row.updatedByUserId,
          row.dispatchedByUserId,
          row.cancelledByUserId,
          row.receiving?.receivedByUserId,
        ]
      : [],
  );

  const users = await freightRepository.getUserSummaries(ids);
  const nameOf = (id) => (id ? displayName(users.get(id)) : null);

  const hydrated = list.map((row) =>
    row
      ? {
          ...row,
          createdByName: nameOf(row.createdByUserId),
          updatedByName: nameOf(row.updatedByUserId),
          dispatchedByName: nameOf(row.dispatchedByUserId),
          cancelledByName: nameOf(row.cancelledByUserId),
          receiving: row.receiving
            ? {
                ...row.receiving,
                receivedByName: nameOf(row.receiving.receivedByUserId),
              }
            : null,
        }
      : row,
  );

  return Array.isArray(rows) ? hydrated : hydrated[0];
};

/* ── Create ───────────────────────────────────────────────────────────────────*/

/**
 * Books a freight shipment.
 *
 * @param actorUserId whoever is signed in. Never taken from the body — a caller
 *   naming its own creator is a caller rewriting the audit trail.
 */
const createFreightShipment = async (data, actorUserId) => {
  if (!actorUserId) {
    throw new Error('An authenticated user is required to create a shipment.');
  }

  const input = normaliseShipmentInput(data);

  // The reference is read and written inside the transaction, so the number it
  // counts from is committed state. Two counters booking at the same instant can
  // still land on the same one — the unique index catches that, and the attempt
  // is made again rather than failing a booking over a race.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const reference = await nextReference(tx);
        return await freightRepository.createFreightShipment(
          {
            ...input,
            reference,
            // The label carries the reference. One value, two columns, on
            // purpose: see the schema comment on `barcode`.
            barcode: reference,
            status: 'BOOKED',
            createdByUserId: actorUserId,
          },
          tx,
        );
      });

      await audit(actorUserId, 'FREIGHT_SHIPMENT_CREATED', {
        freightShipmentId: created.id,
        reference: created.reference,
        senderName: created.senderName,
        destinationCountry: created.destinationCountry,
      });

      return await hydrateActors(created);
    } catch (error) {
      if (attempt >= REFERENCE_ATTEMPTS || !isReferenceClash(error)) throw error;
    }
  }
};

/* ── Read ─────────────────────────────────────────────────────────────────────*/

/**
 * What the list may be narrowed and ordered by.
 *
 * Exported because the /summary handler builds its `where` from this same object
 * and the same req.query. That is what stops the two drifting: the counts above
 * the table cannot describe a different set of rows from the ones in it.
 */
const FREIGHT_SHIPMENT_LIST_SPEC = {
  filters: [
    // The four things staff actually search by, per the spec: the shipment id,
    // the barcode, and either party's name.
    (q) =>
      searchFilter(q.search, ['reference', 'barcode', 'senderName', 'receiverName']),
    (q) => {
      const status = parseEnum(q.status, FREIGHT_STATUSES, { label: 'status' });
      return status ? { status } : undefined;
    },
    (q) => {
      const destinationCountry = parseString(q.destinationCountry, {
        label: 'destinationCountry',
        maxLength: 80,
      });
      return destinationCountry
        ? { destinationCountry: { equals: destinationCountry, mode: 'insensitive' } }
        : undefined;
    },
    (q) => {
      // createdAt is @db.Timestamptz, so the end bound carries to the last
      // instant of the day, built in UTC.
      const range = dateRangeFilter(q.startDate, q.endDate, {
        granularity: 'timestamp',
      });
      return range ? { createdAt: range } : undefined;
    },
  ],
  sort: {
    allowed: {
      createdAt: (order) => ({ createdAt: order }),
      reference: (order) => ({ reference: order }),
      senderName: (order) => ({ senderName: order }),
      receiverName: (order) => ({ receiverName: order }),
      destinationCountry: (order) => ({ destinationCountry: order }),
      status: (order) => ({ status: order }),
      weight: (order) => ({ weight: order }),
      dispatchedAt: (order) => ({ dispatchedAt: order }),
    },
    defaultSort: { field: 'createdAt', order: 'desc' },
    // Must end in a unique key, or two rows sharing a createdAt can swap places
    // between pages and one of them is never seen.
    tiebreaker: [{ id: 'asc' }],
  },
};

const getAllFreightShipments = async (where, options) => {
  const result = await freightRepository.getAllFreightShipments(where, options);
  if (Array.isArray(result)) return await hydrateActors(result);
  return { ...result, items: await hydrateActors(result.items) };
};

const summariseFreightShipments = async (where) =>
  await freightRepository.summariseFreightShipments(where);

const getFreightShipmentById = async (id) => await hydrateActors(await requireShipment(id));

/**
 * The shipment a scanned code belongs to, or null.
 *
 * Barcode first, then reference. The fallback is not a nicety: a label scuffed in
 * transit is read aloud off the paperwork and keyed in, and refusing that would
 * mean a parcel that cannot be received at all.
 *
 * Returns null rather than throwing so the caller decides the status code — an
 * unrecognised code at the bench is an answer, not a server fault.
 */
const lookupByBarcode = async (value) => {
  const code = String(value ?? '').trim();
  if (!code) return { shipment: null, matchedOn: null };

  const byBarcode = await freightRepository.getFreightShipmentByField('barcode', code);
  if (byBarcode) {
    return { shipment: await hydrateActors(byBarcode), matchedOn: 'barcode' };
  }

  const byReference = await freightRepository.getFreightShipmentByField('reference', code);
  if (byReference) {
    return { shipment: await hydrateActors(byReference), matchedOn: 'reference' };
  }

  return { shipment: null, matchedOn: null };
};

/** Who did what to this shipment and when, newest first. */
const getFreightShipmentHistory = async (id) => {
  await requireShipment(id);
  const entries = await freightRepository.getAuditTrail(id);

  return entries.map((entry) => ({
    id: entry.id,
    action: entry.action,
    timestamp: entry.timestamp,
    userName: displayName(entry.user),
    details: entry.details,
  }));
};

/* ── Edit ─────────────────────────────────────────────────────────────────────*/

/**
 * Fields a received shipment will no longer accept.
 *
 * These are what the receiving record was matched against. Editing the sender or
 * the declared weight after the parcel has been checked in rewrites the question
 * the bench answered, and the receiving remarks ("2kg light") stop making sense.
 * Addresses, contacts and remarks stay editable, because a corrected phone number
 * is exactly the kind of thing found out at delivery.
 */
const FROZEN_AFTER_RECEIVING = ['senderName', 'quantity', 'weight', 'weightUnit'];

const updateFreightShipment = async (id, data, actorUserId) => {
  const shipment = await requireShipment(id);

  if (shipment.status === 'CANCELLED') {
    throw new Error('A cancelled freight shipment can no longer be edited.');
  }

  const patch = normalisePatch(data);

  if (shipment.status === 'RECEIVED') {
    const frozen = FROZEN_AFTER_RECEIVING.filter((field) => field in patch);
    if (frozen.length > 0) {
      throw new Error(
        `This shipment has already been received, so ${frozen
          .map((field) => LABELS[field] || field)
          .join(', ')} can no longer be changed.`,
      );
    }
  }

  // The reference and the barcode are absent from every allowlist above, so they
  // cannot arrive here. Saying so once, because "the barcode stays with the
  // shipment id" is a requirement rather than an accident of the field list.
  const updated = await freightRepository.updateFreightShipment(id, {
    ...patch,
    updatedByUserId: actorUserId,
  });

  await audit(actorUserId, 'FREIGHT_SHIPMENT_UPDATED', {
    freightShipmentId: id,
    reference: shipment.reference,
    changed: Object.keys(patch),
    from: Object.fromEntries(Object.keys(patch).map((key) => [key, shipment[key] ?? null])),
    to: patch,
  });

  return await hydrateActors(updated);
};

/* ── Dispatch ─────────────────────────────────────────────────────────────────*/

/**
 * Hands the parcel to the airline.
 *
 * The completeness checks are re-run rather than trusted from creation: a
 * shipment may have been booked before a field was made required, and dispatch is
 * the last moment anyone can still fix it.
 */
const dispatchFreightShipment = async (id, actorUserId) => {
  const shipment = await requireShipment(id);

  assertTransition(shipment.status, 'DISPATCHED');

  if (!shipment.reference) {
    throw new Error('This shipment has no reference and cannot be dispatched.');
  }
  if (!shipment.barcode) {
    throw new Error('This shipment has no barcode and cannot be dispatched.');
  }

  const missing = [
    'senderName',
    'senderContact',
    'senderAddress',
    'receiverName',
    'receiverContact',
    'receiverAddress',
    'destinationCountry',
    'description',
  ].filter((field) => !shipment[field]);

  if (missing.length > 0) {
    throw new Error(
      `This shipment is incomplete and cannot be dispatched. Missing: ${missing
        .map((field) => LABELS[field] || field)
        .join(', ')}.`,
    );
  }

  const updated = await freightRepository.updateFreightShipment(id, {
    status: 'DISPATCHED',
    dispatchedAt: new Date(),
    dispatchedByUserId: actorUserId,
  });

  await audit(actorUserId, 'FREIGHT_SHIPMENT_DISPATCHED', {
    freightShipmentId: id,
    reference: shipment.reference,
    barcode: shipment.barcode,
  });

  return await hydrateActors(updated);
};

/* ── Receive at the UK bench ──────────────────────────────────────────────────*/

/**
 * Checks a parcel in against its barcode.
 *
 * Every refusal here has a matching screen in the spec, so each one carries the
 * sentence the bench should read rather than a generic message.
 *
 * The receiving record and the status change go in one transaction: a record
 * without the status, or a status without the record, are both a parcel nobody
 * can account for. The unique index on freight_shipment_id is what makes the
 * "already received" check safe against two benches scanning at once — the
 * check below is the friendly message; the constraint is the guarantee.
 */
const receiveFreightShipment = async (id, data, actorUserId) => {
  if (!actorUserId) {
    throw new Error('An authenticated user is required to receive a shipment.');
  }

  const shipment = await requireShipment(id);

  if (shipment.status === 'RECEIVED') {
    const error = new Error(
      `Freight shipment ${shipment.reference} has already been received.`,
    );
    error.status = 409;
    // The UI shows who and when, so hand it back rather than making it ask again.
    error.shipment = await hydrateActors(shipment);
    throw error;
  }

  if (shipment.status === 'BOOKED') {
    throw new Error(
      `Freight shipment ${shipment.reference} has not been dispatched yet, so it cannot be received. Check the dispatch was recorded.`,
    );
  }

  assertTransition(shipment.status, 'RECEIVED');

  const actualWeight =
    data.actualWeight === undefined || data.actualWeight === null || data.actualWeight === ''
      ? null
      : normaliseWeight(data.actualWeight, { label: 'Actual weight' });

  const receiving = await prisma.$transaction(async (tx) => {
    const record = await freightRepository.createReceivingRecord(
      {
        freightShipmentId: id,
        // What the gun actually read, when it read anything. Falls back to the
        // shipment's own code for a receipt keyed in by hand.
        barcode: normaliseText(data.barcode, 'barcode', { required: false }) || shipment.barcode,
        receivedByUserId: actorUserId,
        actualWeight,
        actualWeightUnit: actualWeight
          ? normaliseWeightUnit(data.actualWeightUnit, { required: false }) ||
            shipment.weightUnit
          : null,
        remarks: normaliseText(data.remarks, 'remarks', { required: false }) ?? null,
      },
      tx,
    );

    await freightRepository.updateFreightShipment(id, { status: 'RECEIVED' }, tx);

    return record;
  });

  await audit(actorUserId, 'FREIGHT_SHIPMENT_RECEIVED', {
    freightShipmentId: id,
    reference: shipment.reference,
    barcode: receiving.barcode,
    senderName: shipment.senderName,
    actualWeight: actualWeight,
  });

  return await hydrateActors(await requireShipment(id));
};

/* ── Cancel and delete ────────────────────────────────────────────────────────*/

/**
 * Cancel is the soft delete.
 *
 * The record stays readable, because somebody will ask what happened to the
 * parcel they booked. This is the same doctrine the outbound shipments follow —
 * the module has no deletedAt because the WMS has never had one.
 */
const cancelFreightShipment = async (id, actorUserId) => {
  const shipment = await requireShipment(id);

  assertTransition(shipment.status, 'CANCELLED');

  const updated = await freightRepository.updateFreightShipment(id, {
    status: 'CANCELLED',
    cancelledAt: new Date(),
    cancelledByUserId: actorUserId,
  });

  await audit(actorUserId, 'FREIGHT_SHIPMENT_CANCELLED', {
    freightShipmentId: id,
    reference: shipment.reference,
    from: shipment.status,
  });

  return await hydrateActors(updated);
};

/**
 * What deleting a freight shipment would refuse on, and what goes with it. See
 * utils/dependents.js for what blocking and removedWith mean.
 *
 * Blocking: the receiving record. That arrival is a historical fact the
 * business answers questions about, and the row carrying it is the only place
 * it is written down — so a received shipment is kept for good. It cannot be
 * cancelled either: RECEIVED is final.
 *
 * Removed with it: the documents attached to it.
 */
const getFreightShipmentDependents = async (id) => {
  const shipment = await requireShipment(id);
  const received = shipment.status === 'RECEIVED' || Boolean(shipment.receiving);
  return {
    shipment,
    report: buildReport({
      blocking: [
        {
          key: 'receiving',
          label: 'Receiving record at the UK warehouse',
          count: received ? 1 : 0,
          note: 'Its arrival stays on record, so a received shipment is kept for good.',
        },
      ],
      removedWith: [
        { key: 'documents', label: 'Attached documents', count: (shipment.documents ?? []).length },
      ],
    }),
  };
};

/** Removes the record entirely, for a mis-key. */
const deleteFreightShipment = async (id, actorUserId) => {
  const { shipment, report } = await getFreightShipmentDependents(id);
  assertDeletable(`Freight shipment ${shipment.reference}`, report);

  await freightRepository.deleteFreightShipment(id);

  await audit(actorUserId, 'FREIGHT_SHIPMENT_DELETED', {
    freightShipmentId: id,
    reference: shipment.reference,
    status: shipment.status,
  });

  return { message: 'Freight shipment deleted successfully.' };
};

/* ── Documents ────────────────────────────────────────────────────────────────*/

/**
 * Attaches an uploaded booking receipt to the shipment.
 *
 * The file itself is already in object storage by the time this is called — the
 * controller does that, as the expenses upload does, because the buffer belongs
 * to the HTTP layer. This records where it went and who put it there.
 */
const attachDocument = async (id, document, actorUserId) => {
  const shipment = await requireShipment(id);

  const created = await freightRepository.createDocument({
    freightShipmentId: id,
    fileName: document.fileName,
    storageKey: document.storageKey,
    fileType: document.fileType,
    uploadedByUserId: actorUserId,
  });

  await audit(actorUserId, 'FREIGHT_SHIPMENT_DOCUMENT_UPLOADED', {
    freightShipmentId: id,
    reference: shipment.reference,
    documentId: created.id,
    fileName: created.fileName,
  });

  return created;
};

/**
 * Detaches a document.
 *
 * The row goes; the stored object stays. lib/objectStorage has no delete helper —
 * nothing in this codebase deletes objects — and inventing one here would make
 * this module the only place a file can be destroyed, which is not a power a
 * booking clerk needs to correct a wrong attachment.
 */
const removeDocument = async (id, documentId, actorUserId) => {
  const shipment = await requireShipment(id);

  const document = await freightRepository.getDocumentById(documentId);
  if (!document || document.freightShipmentId !== id) {
    const error = new Error('Document not found on this shipment.');
    error.status = 404;
    throw error;
  }

  await freightRepository.deleteDocument(documentId);

  await audit(actorUserId, 'FREIGHT_SHIPMENT_DOCUMENT_REMOVED', {
    freightShipmentId: id,
    reference: shipment.reference,
    documentId,
    fileName: document.fileName,
  });

  return { message: 'Document removed successfully.' };
};

/** Whether this storage key belongs to a freight document, for the stream route. */
const documentForStorageKey = async (storageKey) =>
  await freightRepository.getDocumentByStorageKey(storageKey);

module.exports = {
  FREIGHT_SHIPMENT_LIST_SPEC,
  FREIGHT_STATUSES,
  WEIGHT_UNITS,
  createFreightShipment,
  getAllFreightShipments,
  summariseFreightShipments,
  getFreightShipmentById,
  getFreightShipmentHistory,
  lookupByBarcode,
  updateFreightShipment,
  dispatchFreightShipment,
  receiveFreightShipment,
  cancelFreightShipment,
  deleteFreightShipment,
  attachDocument,
  removeDocument,
  documentForStorageKey,
  // Exported for tests and for the receiving flow's own guards.
  getFreightShipmentDependents,
  FREIGHT_TRANSITIONS,
  FROZEN_AFTER_RECEIVING,
  assertTransition,
  nextReference,
  normaliseShipmentInput,
  normalisePatch,
  normaliseWeight,
  normaliseContact,
};
