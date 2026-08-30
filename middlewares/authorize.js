const userRepository = require('../repositories/user.repository');
const { verifyAuthToken } = require('../utils/jwt');
const {
    getCachedUser,
    setCachedUser,
} = require('../utils/authUserCache');

/**
 * Extracts a bearer JWT from the Authorization header.
 * Only "Authorization: Bearer <jwt>" is accepted.
 */
const extractBearerToken = (req) => {
    const authHeader = req.header('authorization') || '';
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        return authHeader.slice(7).trim();
    }
    return null;
};

/**
 * Authenticates the request from a signed JWT and (optionally) enforces roles.
 * User records are cached briefly (AUTH_USER_CACHE_TTL_MS) to cut DB load under
 * concurrency; deactivated accounts still expire within the TTL window.
 *
 * Usage:
 *   authorizeRoles()                 -> any authenticated, active user
 *   authorizeRoles('admin')          -> admins only
 *   authorizeRoles('admin', 'employee')
 */
const authorizeRoles = (...allowedRoles) => {
    const normalizedAllowedRoles = allowedRoles.flat().filter(Boolean);

    return async (req, res, next) => {
        try {
            const token = extractBearerToken(req);
            if (!token) {
                return res.status(401).json({ error: 'Authentication required.' });
            }

            let payload;
            try {
                payload = verifyAuthToken(token);
            } catch (err) {
                return res.status(401).json({ error: 'Invalid or expired session.' });
            }

            const actorId = payload && payload.sub;
            if (!actorId) {
                return res.status(401).json({ error: 'Invalid session.' });
            }

            let user = getCachedUser(actorId);
            if (!user) {
                user = await userRepository.getUserByField('id', actorId);
                if (user) {
                    setCachedUser(actorId, user);
                }
            }

            if (!user) {
                return res.status(401).json({ error: 'User not found.' });
            }

            if (!user.isActive) {
                return res.status(403).json({ error: 'Account is not active.' });
            }

            // The revocation check. A token carries the tokenVersion it was
            // minted at; bumping the user's version invalidates every token
            // already out there. Without this a leaked token stays valid for its
            // full life and a password reset cannot end the session.
            //
            // Tokens issued before this column existed have no `tv`, so they are
            // treated as stale and the holder logs in again once.
            const tokenVersion = payload.tv;
            if (tokenVersion === undefined || tokenVersion !== user.tokenVersion) {
                return res
                    .status(401)
                    .json({ error: 'Session has been revoked. Please sign in again.' });
            }

            if (normalizedAllowedRoles.length > 0 && !normalizedAllowedRoles.includes(user.role)) {
                return res.status(403).json({ error: 'You do not have permission to perform this action.' });
            }

            req.user = {
                id: user.id,
                role: user.role,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                username: user.username,
                isActive: user.isActive,
            };

            return next();
        } catch (error) {
            return next(error);
        }
    };
};

module.exports = {
    authorizeRoles,
    authenticate: authorizeRoles(),
};
