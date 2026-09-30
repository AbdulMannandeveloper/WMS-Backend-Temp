'use strict';

/**
 * What an employee may be granted.
 *
 * Role alone was too coarse. authorizeRoles('admin','employee') means every
 * employee who passes it can do everything that route allows — so anyone could
 * create a shipment or add a product, and nobody could delete anything, because
 * deletes were admin-only. An admin needs to say that this person receives
 * goods but does not adjust stock.
 *
 * Four modules, four actions, sixteen strings. Deliberately a closed list
 * rather than a free-form string: the write endpoint checks every entry against
 * it, so a typo is refused rather than stored and silently granting nothing.
 *
 * Only the employee role is governed by these. An admin is not — a permission
 * list that could lock out an admin is a way to lose the system — and a client
 * is not, because client access is already narrowed by utils/clientScope.js.
 */

/** The modules under permission control. Everything else keeps its role check. */
const MODULES = Object.freeze({
  SHIPMENTS: 'shipments',
  FBA: 'fba',
  INVENTORY: 'inventory',
  RETURNS: 'returns',
  // The Pakistan → UK freight leg. Booking a parcel, dispatching it and
  // receiving it at the UK bench are three different people's work, which is
  // exactly the case this list exists for.
  FREIGHT: 'freight',
});

const ACTIONS = Object.freeze(['create', 'read', 'update', 'delete']);

/** `module:action`, which is the form stored on the user and sent by the UI. */
const permission = (module, action) => `${module}:${action}`;

const ALL_PERMISSIONS = Object.freeze(
  Object.values(MODULES).flatMap((module) =>
    ACTIONS.map((action) => permission(module, action)),
  ),
);

const PERMISSION_SET = new Set(ALL_PERMISSIONS);

const isKnownPermission = (value) =>
  typeof value === 'string' && PERMISSION_SET.has(value);

/**
 * Validates a whole list, returning it de-duplicated and in a stable order.
 *
 * Order matters only so that two grants of the same set compare equal in an
 * audit log entry — a diff that reads as a change when nothing changed is
 * noise in the one place that should be trustworthy.
 *
 * @throws {Error & {status: 400}} naming every unrecognised entry, not just the
 *   first, so fixing a bad request takes one round trip rather than four.
 */
const normalisePermissions = (value) => {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) {
    const error = new Error('permissions must be an array.');
    error.status = 400;
    throw error;
  }

  const unknown = value.filter((entry) => !isKnownPermission(entry));
  if (unknown.length > 0) {
    const error = new Error(
      `Unknown permission${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`,
    );
    error.status = 400;
    throw error;
  }

  const held = new Set(value);
  return ALL_PERMISSIONS.filter((entry) => held.has(entry));
};

/**
 * Whether this user may take this action.
 *
 * Reads the role first on purpose. An admin is allowed without the list being
 * consulted at all, which is what keeps an empty permissions column from
 * locking the system, and a client falls through to the scoping that already
 * governs it rather than being asked for a permission it can never hold.
 */
const holdsPermission = (user, module, action) => {
  if (!user) return false;
  if (user.role !== 'employee') return true;
  return Array.isArray(user.permissions)
    ? user.permissions.includes(permission(module, action))
    : false;
};

module.exports = {
  MODULES,
  ACTIONS,
  ALL_PERMISSIONS,
  permission,
  isKnownPermission,
  normalisePermissions,
  holdsPermission,
};
