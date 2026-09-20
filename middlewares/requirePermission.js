'use strict';

const { holdsPermission } = require('../utils/permissions');

/**
 * Narrows a route to employees who hold a specific permission.
 *
 * Chained after authorizeRoles, never instead of it:
 *
 *   router.post('/', staffOnly, requirePermission('shipments', 'create'), handler)
 *
 * That order is load-bearing. authorizeRoles returns early and never calls
 * next() when it refuses, so this only ever runs on a request that is already
 * authenticated, active, un-revoked and role-approved — and req.user is
 * populated by the time it does. Putting this first would read permissions off
 * an undefined user and let an anonymous request through.
 *
 * Only the employee role is governed. An admin passes because permissions exist
 * to give employees a subset of what an admin does, not to constrain the person
 * administering the system. A client passes because its access is already
 * narrowed by utils/clientScope.js, on routes where that narrowing is the whole
 * point — asking a client for shipments:read would refuse it the portal.
 *
 * The permissions themselves come from the user record that authorizeRoles
 * already loaded and cached, so this costs nothing per request. That is also
 * why a grant must invalidate that cache: see utils/authUserCache.js.
 */
const requirePermission = (module, action) => (req, res, next) => {
  if (holdsPermission(req.user, module, action)) {
    return next();
  }

  // The same shape authorizeRoles refuses with, so nothing downstream — or in
  // the front end's error mapping — has to tell the two apart.
  return res
    .status(403)
    .json({ error: 'You do not have permission to perform this action.' });
};

module.exports = { requirePermission };
