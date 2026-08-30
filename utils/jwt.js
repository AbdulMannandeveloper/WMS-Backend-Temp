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

/**
 * Whether the browser will send this cookie to an API on a different site.
 *
 * Deployed behind one origin — nginx serving the app and proxying /api, or a
 * single service doing both — the frontend and API are same-site and Lax is
 * correct: the cookie still travels, and Lax blocks it on cross-site POSTs,
 * which is free CSRF protection.
 *
 * Split across hosts (Vercel + Render, say) they are cross-site, because
 * .vercel.app and .onrender.com are on the Public Suffix List and each
 * subdomain counts as its own site. A Lax cookie is then never sent to the API
 * at all — and because the app calls refresh on load to restore a session, the
 * visible symptom is being thrown back to the login screen on every page
 * refresh, not a subtle one.
 *
 * SameSite=None fixes that and gives up Lax's CSRF protection. The exposure is
 * narrow: this cookie only buys a new access token, and every state-changing
 * route requires that token in an Authorization header, which a cross-site page
 * cannot set. Off by default so the safer setting is what you get unless the
 * deployment actually needs otherwise.
 */
const isCrossSite = () =>
  String(process.env.CROSS_SITE_COOKIES || '').toLowerCase() === 'true';

/** Cookie options for the refresh token. */
const refreshCookieOptions = () => {
  const days = Number(process.env.REFRESH_COOKIE_DAYS || 7);
  const crossSite = isCrossSite();

  return {
    httpOnly: true,
    sameSite: crossSite ? 'none' : 'lax',
    // Browsers refuse a Secure cookie over plain HTTP, so this cannot be on in
    // local development or nothing would be set at all. SameSite=None *requires*
    // Secure, so a cross-site cookie is forced secure regardless — a None cookie
    // without it is simply dropped, which would look exactly like the bug this
    // setting exists to fix.
    secure: process.env.NODE_ENV === 'production' || crossSite,
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
  isCrossSite,
  REFRESH_COOKIE_NAME,
  ACCESS_TTL,
  REFRESH_TTL,
};
