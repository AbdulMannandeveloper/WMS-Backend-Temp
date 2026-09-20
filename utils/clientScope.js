const clientRepository = require('../repositories/client.repository');

/**
 * Resolves the client record a request is limited to.
 *
 * Clients may only ever read their own data, so their scope is derived from the
 * authenticated user rather than from anything they send. Staff (admin/employee)
 * are not scope-limited and resolve to null.
 *
 * @returns {Promise<string|null>} the caller's own clientId, or null for staff
 * @throws when a client login has no linked client record
 */
const resolveOwnClientId = async (user) => {
    if (!user || user.role !== 'client') {
        return null;
    }

    const ownClient = await clientRepository.getClientByField('userId', user.id);
    if (!ownClient) {
        throw new Error('No client account is linked to this login.');
    }

    return ownClient.id;
};

/**
 * Guards a route that takes a :clientId parameter.
 * Staff may read any client; a client may only read itself.
 *
 * @returns {Promise<boolean>} true when the caller may proceed
 */
const canAccessClientId = async (user, clientId) => {
    const ownClientId = await resolveOwnClientId(user);
    return ownClientId === null || ownClientId === clientId;
};

/**
 * The single client a list read is limited to, or null for unscoped staff.
 *
 * This exists because two endpoints scope a client by swapping which repository
 * function they call — product.controller.js and fba.controller.js both pick
 * getXByClientId or getAllX — rather than by composing a where. That shape has
 * nowhere to put a clientId filter parameter: the caller's value and the
 * caller's identity become two separate code paths, and the day they disagree a
 * client reads another client's catalogue.
 *
 * Here they cannot disagree. A client's own id always wins. A client asking for
 * someone else's gets the same 404 the rest of the portal gives, so an id
 * cannot be probed by watching which error comes back. Only staff may point the
 * filter anywhere.
 *
 * @throws {Error & {status: 404}} when a client asks for another client
 */
const resolveClientFilter = async (user, requestedClientId) => {
    const ownClientId = await resolveOwnClientId(user);

    if (ownClientId) {
        if (requestedClientId && requestedClientId !== ownClientId) {
            const error = new Error('Client not found.');
            error.status = 404;
            throw error;
        }
        return ownClientId;
    }

    return requestedClientId || null;
};

module.exports = {
    resolveOwnClientId,
    canAccessClientId,
    resolveClientFilter,
};
