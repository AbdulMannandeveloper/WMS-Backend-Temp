const jwt = require('jsonwebtoken');

const getSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured. Set it in the environment.');
  }
  return secret;
};

const getExpiresIn = () => process.env.JWT_EXPIRES_IN || '12h';

/**
 * Issues a signed session token for a user.
 * The token carries only the user id (subject) and role. The role is always
 * re-validated against the database on each request, so a stale role claim
 * cannot be used to escalate privileges.
 */
const signAuthToken = (user) =>
  jwt.sign({ role: user.role }, getSecret(), {
    subject: String(user.id),
    expiresIn: getExpiresIn(),
  });

const verifyAuthToken = (token) => jwt.verify(token, getSecret());

module.exports = {
  signAuthToken,
  verifyAuthToken,
};
