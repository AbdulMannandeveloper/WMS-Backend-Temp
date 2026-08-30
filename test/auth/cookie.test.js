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

const withEnv = (vars, fn) => {
  const previous = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

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

describe('cross-site deployment', () => {
  it('uses Lax by default, which is the safer setting', () => {
    // Same-origin deployments get CSRF protection for free, so it has to be
    // what you get without opting out.
    withEnv({ CROSS_SITE_COOKIES: undefined }, () => {
      expect(refreshCookieOptions().sameSite).toBe('lax');
    });
  });

  it('switches to None when the frontend is on another site', () => {
    // Vercel + Render are cross-site: .vercel.app and .onrender.com are on the
    // Public Suffix List, so each subdomain is its own site and a Lax cookie is
    // never sent to the API at all.
    withEnv({ CROSS_SITE_COOKIES: 'true' }, () => {
      expect(refreshCookieOptions().sameSite).toBe('none');
    });
  });

  it('forces Secure with None, even outside production', () => {
    // A SameSite=None cookie without Secure is dropped by the browser — which
    // would look exactly like the bug this setting exists to fix.
    withEnv({ CROSS_SITE_COOKIES: 'true', NODE_ENV: 'development' }, () => {
      const options = refreshCookieOptions();
      expect(options.sameSite).toBe('none');
      expect(options.secure).toBe(true);
    });
  });

  it('leaves local development on Lax without Secure', () => {
    // Browsers refuse a Secure cookie over plain http, so turning it on here
    // would mean no cookie is set at all.
    withEnv({ CROSS_SITE_COOKIES: undefined, NODE_ENV: 'development' }, () => {
      const options = refreshCookieOptions();
      expect(options.sameSite).toBe('lax');
      expect(options.secure).toBe(false);
    });
  });

  it('only accepts a literal "true", not any truthy string', () => {
    // Otherwise CROSS_SITE_COOKIES=false would enable it.
    for (const value of ['false', '0', 'no', '']) {
      withEnv({ CROSS_SITE_COOKIES: value }, () => {
        expect(refreshCookieOptions().sameSite).toBe('lax');
      });
    }
  });

  it('clears the cookie with the same SameSite it was set with', () => {
    // A cookie is only cleared when the attributes match; a mismatch here
    // leaves a stale refresh token in the browser after logout.
    withEnv({ CROSS_SITE_COOKIES: 'true' }, () => {
      expect(refreshCookieClearOptions().sameSite).toBe('none');
      expect(refreshCookieClearOptions().secure).toBe(true);
    });
  });
});
