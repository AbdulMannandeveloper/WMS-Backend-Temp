'use strict';

/**
 * What a client is allowed to see of an air freight response.
 *
 * The portal serves clients through the same handlers as staff — holdsPermission
 * lets a client past the permission gate — so every client-facing response is
 * put through here in the controller's send(), the way the returns module runs
 * every response through redactMoney. It removes what is ours and not theirs:
 * internal notes, which member of staff did what, and anything about billing.
 *
 * It strips by denylist and recurses, so a field added to a model later is only
 * exposed to clients if someone also adds it to a client-facing include — not
 * by this function quietly letting it through.
 */

/** Keys removed from every object, at any depth. */
const DENY_KEYS = new Set([
  'internalNote',
  'chargeable',
  'billingStatus',
  'billingSnapshot',
  'billingPostReason',
  'billingPostedAt',
  'notifiedMilestones',
  'cancelReason',
  'email', // the client summary nested on a flight — they know their own address
]);

/** Event types whose free-text note is safe to show a client as-is. */
const CLIENT_SAFE_EVENT_NOTES = new Set([
  'MANIFESTED',
  'DISPATCHED',
  'LANDED',
  'CLEARED',
  'RECEIVED',
  'HANDED_TO_COURIER',
  'RETURNED',
]);

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

const redactForClient = (data) => {
  if (Array.isArray(data)) return data.map(redactForClient);
  if (!isPlainObject(data)) return data;

  const out = {};
  const isEvent = 'eventType' in data && 'toStatus' in data;

  for (const [key, value] of Object.entries(data)) {
    if (DENY_KEYS.has(key)) continue;
    // Who did it is never shown; *ByUserId and the raw userId both go.
    if (key.endsWith('ByUserId') || key === 'userId') continue;

    if (isEvent && key === 'note') {
      out.note = CLIENT_SAFE_EVENT_NOTES.has(data.eventType) ? value : null;
      continue;
    }

    out[key] = redactForClient(value);
  }
  return out;
};

module.exports = { redactForClient, DENY_KEYS, CLIENT_SAFE_EVENT_NOTES };
