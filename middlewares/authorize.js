const userRepository = require('../repositories/user.repository');

const resolveActorId = (req) => {
    const authHeader = req.header('authorization') || '';
    const bearerUserId = authHeader.toLowerCase().startsWith('token ')
        ? authHeader.slice(6).trim()
        : null;

    return (
        (req.user && req.user.id) ||
        req.header('x-user-id') ||
        bearerUserId ||
        null
    );
};

const authorizeRoles = (...allowedRoles) => {
    const normalizedAllowedRoles = allowedRoles.flat().filter(Boolean);

    return async (req, res, next) => {
        try {
            const actorId = resolveActorId(req);

            if (!actorId) {
                return res.status(401).json({ error: 'Authentication required.' });
            }

            const user = await userRepository.getUserByField('id', actorId);

            if (!user) {
                return res.status(401).json({ error: 'User not found.' });
            }

            if (!user.isActive) {
                return res.status(403).json({ error: 'Account is not active.' });
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
};