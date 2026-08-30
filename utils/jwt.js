const jwt = require('jsonwebtoken');

const getSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured. Set it in the environment.');
  }
  return secret;
};

/**
 * Two tokens, deliberately different.
 *
 * The access token is short and lives in memory on the client — never in
 * localStorage, where any XSS can read it. The refresh token is long and lives
 * in an httpOnly cookie, which JavaScript cannot reach at all.
 *
 * Both carry `tv`, the user's tokenVersion at minting time. authorizeRoles
 * compares it against the current value, so bumping tokenVersion invalidates
 * every token already issued to that user. That is the whole point: before this,
 * a leaked token was valid for its full life and an admin resetting the
 * password could not end the session.
 *
 * Note on what this does NOT give you: these are stateless JWTs, so refreshing
 * mints a token that is byte-identical to the previous one when it lands in the
 * same second. Handing back a "new" cookie therefore does not invalidate a
 * stolen refresh token — only bumping tokenVersion does, and that ends every
 * session the user has. Per-token revocation would need the current refresh
 * token (or a jti) stored server-side; worth doing if single-session-per-device
 * control is ever required, but it is not what is implemented here.
 */
const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_TTL = process.env.REFRESH_TOKEN_TTL || '7d';

const TYPE_ACCESS = 'access';
const TYPE_REFRESH = 'refresh';

const signAuthToken = (user) =>
  jwt.sign(
    { role: user.role, tv: user.tokenVersion ?? 0, typ: TYPE_ACCESS },
    getSecret(),
    { subject: String(user.id), expiresIn: ACCESS_TTL },
  );

const signRefreshToken = (user) =>
  jwt.sign(
    { tv: user.tokenVersion ?? 0, typ: TYPE_REFRESH },
    getSecret(),
    { subject: String(user.id), expiresIn: REFRESH_TTL },
  );

const verifyAuthToken = (token) => {
  const payload = jwt.verify(token, getSecret());
  // A refresh token must not be usable as an access token. They are signed with
  // the same secret, so without this check the long-lived one would authorise
  // requests directly and the short access TTL would buy nothing.
  if (payload.typ && payload.typ !== TYPE_ACCESS) {
    throw new jwt.JsonWebTokenError('Not an access token.');
  }
  return payload;
};

const verifyRefreshToken = (token) => {
  const payload = jwt.verify(token, getSecret());
  if (payload.typ !== TYPE_REFRESH) {
    throw new jwt.JsonWebTokenError('Not a refresh token.');
  }
  return payload;
};

/** Cookie options for the refresh token. */
const refreshCookieOptions = () => {
  const days = Number(process.env.REFRESH_COOKIE_DAYS || 7);
  return {
    httpOnly: true,
    // Same origin in production (nginx serves the app and proxies /api), so Lax
    // is enough and avoids SameSite=None, which needs cross-site cookies that
    // browsers keep restricting.
    sameSite: 'lax',
    // Browsers refuse a Secure cookie over plain HTTP, so this cannot be on in
    // local development or nothing would be set at all.
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth',
    maxAge: days * 24 * 60 * 60 * 1000,
  };
};

/**
 * Options for *clearing* the refresh cookie.
 *
 * Same attributes minus maxAge. A cookie is only cleared when the attributes
 * match the ones it was set with, so path/sameSite/secure have to stay — but
 * Express deprecates maxAge on clearCookie and ignores it outright in v5, and
 * passing it printed a deprecation on every logout.
 */
const refreshCookieClearOptions = () => {
  const { maxAge, ...rest } = refreshCookieOptions();
  void maxAge;
  return rest;
};

const REFRESH_COOKIE_NAME = 'pp_refresh';

module.exports = {
  signAuthToken,
  signRefreshToken,
  verifyAuthToken,
  verifyRefreshToken,
  refreshCookieOptions,
  refreshCookieClearOptions,
  REFRESH_COOKIE_NAME,
  ACCESS_TTL,
  REFRESH_TTL,
};
