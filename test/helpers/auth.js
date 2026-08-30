import '../load-env.js';

import request from 'supertest';

import appModule from '../../app.js';
import jwtUtil from '../../utils/jwt.js';

const { app } = appModule;
const { signAuthToken } = jwtUtil;

/**
 * Mints a bearer token directly rather than driving login + OTP.
 *
 * Tests that are not about authentication should not depend on the auth flow;
 * this uses the same signing function the real login uses, so the token is
 * indistinguishable to middlewares/authorize.js.
 *
 * `tokenVersion` has to travel with it. Tokens carry the version they were
 * minted at and authorize.js rejects a stale one, so a helper that omitted it
 * would 401 every authenticated test in the suite.
 */
export const tokenFor = (user) =>
  signAuthToken({
    id: user.id,
    role: user.role,
    tokenVersion: user.tokenVersion ?? 0,
  });

export const authHeader = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });

/** Supertest agent with the Authorization header already attached. */
export const as = (user) => {
  const header = authHeader(user);
  const wrap = (method) => (url) => request(app)[method](url).set(header);

  return {
    get: wrap('get'),
    post: wrap('post'),
    put: wrap('put'),
    patch: wrap('patch'),
    delete: wrap('delete'),
  };
};

/** Unauthenticated requests. */
export const anon = () => request(app);
