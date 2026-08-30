/**
 * How outbound mail connects.
 *
 * smtp.gmail.com is dual-stack. Hosts without an IPv6 route — Render among
 * them — resolve the AAAA record and fail with ENETUNREACH before reaching the
 * server at all. The symptom is a retry loop against an address like
 * 2a00:1450:4001:c21::6d while the credentials, host and port are entirely
 * correct, so the error points at the network and gives no hint that the
 * lookup picked the wrong address family.
 *
 * Every invitation, OTP and approved-invoice email goes through this, and the
 * failure is silent from the user's side — they are told to check their email
 * and nothing arrives.
 */

import { describe, it, expect } from 'vitest';

import mailer from '../../utils/mailer.js';

const { buildTransportOptions } = mailer;

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

describe('the SMTP connection', () => {
  it('uses IPv4 by default', () => {
    // The whole point: without this, mail silently fails on any host with no
    // IPv6 route.
    withEnv({ SMTP_IP_FAMILY: undefined }, () => {
      expect(buildTransportOptions().family).toBe(4);
    });
  });

  it('can be forced to IPv6 for a network that needs it', () => {
    withEnv({ SMTP_IP_FAMILY: '6' }, () => {
      expect(buildTransportOptions().family).toBe(6);
    });
  });

  it('never leaves the family unset', () => {
    // Unset means Node chooses, which is how this failed in the first place.
    for (const value of [undefined, '', 'nonsense']) {
      withEnv({ SMTP_IP_FAMILY: value }, () => {
        const family = buildTransportOptions().family;
        expect(Number.isFinite(family)).toBe(true);
        expect([4, 6]).toContain(family);
      });
    }
  });

  it('still carries host, port and credentials', () => {
    // The family option must not have displaced anything.
    const options = buildTransportOptions();
    expect(options).toHaveProperty('host');
    expect(options).toHaveProperty('port');
    expect(options).toHaveProperty('auth');
    expect(options.auth).toHaveProperty('user');
    expect(options.auth).toHaveProperty('pass');
  });
});
