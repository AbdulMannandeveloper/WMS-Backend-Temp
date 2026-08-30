/**
 * The refresh cookie, and clearing it properly.
 *
 * A cookie is only cleared when the attributes match the ones it was set with,
 * so path/sameSite/secure have to be carried through. maxAge must not be:
 * Express deprecates it on clearCookie and ignores it outright in v5, and
 * passing it printed a deprecation warning on every single logout.
 */

import { describe, it, expect } from 'vitest';

import jwtUtil from '../../utils/jwt.js';

const { refreshCookieOptions, refreshCookieClearOptions } = jwtUtil;

describe('clear options', () => {
  it('carry no maxAge', () => {
    // The deprecation, in one assertion.
    expect(refreshCookieClearOptions()).not.toHaveProperty('maxAge');
  });

  it('still carry the attributes that make the clear match the cookie', () => {
    // Drop any of these and the browser keeps the cookie: it treats a cookie on
    // a different path or SameSite as a different cookie entirely.
    const set = refreshCookieOptions();
    const clear = refreshCookieClearOptions();

    expect(clear.path).toBe(set.path);
    expect(clear.sameSite).toBe(set.sameSite);
    expect(clear.secure).toBe(set.secure);
    expect(clear.httpOnly).toBe(set.httpOnly);
  });

  it('differ from the set options only by maxAge', () => {
    const set = refreshCookieOptions();
    const clear = refreshCookieClearOptions();

    expect(Object.keys(clear).sort()).toEqual(
      Object.keys(set).filter((k) => k !== 'maxAge').sort()
    );
  });
});

describe('set options', () => {
  it('keep the cookie out of reach of JavaScript', () => {
    // The whole reason the refresh token lives in a cookie rather than
    // localStorage: an XSS cannot read it.
    expect(refreshCookieOptions().httpOnly).toBe(true);
  });

  it('scope it to the auth endpoints only', () => {
    expect(refreshCookieOptions().path).toBe('/api/auth');
  });

  it('do carry a maxAge, so the cookie survives a browser restart', () => {
    // Without it the cookie is a session cookie and closing the tab signs you
    // out — which is what clearCookie must NOT copy.
    expect(refreshCookieOptions().maxAge).toBeGreaterThan(0);
  });
});
