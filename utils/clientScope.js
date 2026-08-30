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

module.exports = {
    resolveOwnClientId,
    canAccessClientId,
};
