/**
 * Sessions that can actually be revoked.
 *
 * Before this, the JWT sat in localStorage where any XSS could read it, lasted
 * twelve hours, and logout only cleared client state. There was no server-side
 * revocation at all — so a leaked token stayed valid for its full life, and an
 * admin resetting a compromised user's password did not sign the attacker out.
 *
 * Now every token carries the tokenVersion it was minted at, and bumping that
 * version invalidates all of them at once. These tests hold that line, because
 * the failure mode is silent: everything still "works" while a revoked session
 * keeps functioning.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon, tokenFor } from '../helpers/auth.js';
import { makeAdmin, makeUser, makeClient } from '../factories/index.js';

const REFRESH_COOKIE = 'pp_refresh';

/** Reads the user back, so a token is minted at the current version. */
const reload = (id) => prisma.user.findUnique({ where: { id } });

describe('token revocation', () => {
  it('accepts a token minted at the current version', async () => {
    const admin = await makeAdmin();

    const res = await as(admin).get('/api/clients');

    expect(res.status).toBe(200);
  });

  it('rejects a token once the session is revoked', async () => {
    // The core guarantee. The token is otherwise perfectly valid: correct
    // signature, unexpired, real active user.
    const admin = await makeAdmin();
    const token = tokenFor(admin);

    await expect(
      anon().get('/api/clients').set('Authorization', `Bearer ${token}`).then((r) => r.status),
    ).resolves.toBe(200);

    // Through the real path, which also drops the cached user record.
    await as(admin).post('/api/auth/logout-all');

    const after = await anon()
      .get('/api/clients')
      .set('Authorization', `Bearer ${token}`);

    expect(after.status).toBe(401);
    expect(after.body.error).toMatch(/revoked/i);
  });

  it('a bump that skips cache invalidation is NOT seen until the cache expires', async () => {
    // Documenting a real limit rather than hiding it. middlewares/authorize.js
    // caches the user for 45s, so revocation is only as immediate as that cache.
    // Every code path that revokes calls invalidateCachedUser — but under PM2
    // clustering the cache is per-process, so a bump on one worker is invisible
    // to the others for the TTL. That is what the Redis-backed cache fixes.
    const admin = await makeAdmin();
    const token = tokenFor(admin);
    await anon().get('/api/clients').set('Authorization', `Bearer ${token}`); // caches

    await prisma.user.update({
      where: { id: admin.id },
      data: { tokenVersion: { increment: 1 } },
    });

    const after = await anon()
      .get('/api/clients')
      .set('Authorization', `Bearer ${token}`);

    expect(after.status).toBe(200); // stale, by design of the cache
    const row = await reload(admin.id);
    expect(row.tokenVersion).toBe(1); // the database did move on
  });

  it('rejects a token carrying no version at all', async () => {
    // Tokens minted before the column existed. They must not be trusted by
    // default, or the whole mechanism is opt-in for an attacker.
    const admin = await makeAdmin();
    const jwt = await import('jsonwebtoken');
    const legacy = jwt.default.sign(
      { role: admin.role }, // no `tv`
      process.env.JWT_SECRET,
      { subject: admin.id, expiresIn: '1h' },
    );

    const res = await anon().get('/api/clients').set('Authorization', `Bearer ${legacy}`);

    expect(res.status).toBe(401);
  });

  it('deactivating a user kills the session they are holding', async () => {
    const admin = await makeAdmin();
    // A pre-existing rule refuses to change isActive until the user has
    // completed password setup, so the fixture needs one.
    const victim = await makeUser({ role: 'employee', passwordHash: 'x'.repeat(20) });
    const victimToken = tokenFor(victim);

    await expect(
      anon().get('/api/holidays').set('Authorization', `Bearer ${victimToken}`).then((r) => r.status),
    ).resolves.toBe(200);

    await as(admin).put(`/api/users/${victim.id}`).send({ isActive: false });

    const after = await anon()
      .get('/api/holidays')
      .set('Authorization', `Bearer ${victimToken}`);

    // Either revoked or inactive — both end the session; what matters is that
    // it stops working immediately rather than at token expiry.
    expect([401, 403]).toContain(after.status);
  });

  it('changing a role kills the token carrying the old one', async () => {
    // Otherwise a demoted admin keeps admin rights in the token they hold.
    const admin = await makeAdmin();
    const target = await makeUser({ role: 'admin', passwordHash: 'x'.repeat(20) });
    const oldToken = tokenFor(target);

    await as(admin).put(`/api/users/${target.id}`).send({ role: 'employee' });

    const res = await anon().get('/api/clients').set('Authorization', `Bearer ${oldToken}`);

    expect(res.status).toBe(401);
  });
});

describe('refresh', () => {
  const login = async () => {
    // Mint the pair the way the controller does, without driving OTP.
    const user = await makeAdmin();
    const jwtUtil = await import('../../utils/jwt.js').then((m) => m.default);
    return { user, refresh: jwtUtil.signRefreshToken(user) };
  };

  it('exchanges a refresh cookie for a working access token', async () => {
    const { refresh } = await login();

    const res = await anon()
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${refresh}`);

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();

    const used = await anon()
      .get('/api/clients')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(used.status).toBe(200);
  });

  it('re-issues the cookie httpOnly, and scoped to the auth routes', async () => {
    const { refresh } = await login();

    const first = await anon()
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${refresh}`);
    expect(first.status).toBe(200);

    const setCookie = String(first.headers['set-cookie'] ?? '');
    expect(setCookie).toContain(REFRESH_COOKIE);
    // The property that matters: JavaScript cannot read it, so an XSS cannot
    // steal the long-lived half of the session.
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/api/auth');

    // Deliberately NOT asserting the value changed. These are stateless JWTs:
    // one minted in the same second carries the same payload and is byte
    // identical, so re-issuing does not invalidate the old one. Ending a
    // specific stolen token would need server-side refresh state; today
    // revocation is tokenVersion, which ends every session at once.
  });

  it('refuses a refresh token after the session is revoked', async () => {
    const { user, refresh } = await login();

    await prisma.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
    });

    const res = await anon()
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${refresh}`);

    expect(res.status).toBe(401);
  });

  it('refuses to refresh with no cookie', async () => {
    const res = await anon().post('/api/auth/refresh');

    expect(res.status).toBe(401);
  });

  it('will not accept a refresh token as an access token', async () => {
    // They are signed with the same secret. Without the type check the
    // long-lived token would authorise requests directly and the short access
    // TTL would buy nothing.
    const { refresh } = await login();

    const res = await anon().get('/api/clients').set('Authorization', `Bearer ${refresh}`);

    expect(res.status).toBe(401);
  });

  it('will not accept an access token as a refresh token', async () => {
    const admin = await makeAdmin();

    const res = await anon()
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${tokenFor(admin)}`);

    expect(res.status).toBe(401);
  });

  it('refuses to refresh a deactivated account', async () => {
    const { user, refresh } = await login();
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    const res = await anon()
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${refresh}`);

    expect(res.status).toBe(401);
  });
});

describe('logging out', () => {
  it('clears the cookie for this device', async () => {
    const res = await anon().post('/api/auth/logout');

    expect(res.status).toBe(200);
    expect(String(res.headers['set-cookie'] ?? '')).toContain(REFRESH_COOKIE);
  });

  it('logout-all revokes every session that user holds', async () => {
    const admin = await makeAdmin();
    // A second device: same user, separately minted token.
    const otherDevice = tokenFor(admin);

    const res = await as(admin).post('/api/auth/logout-all');
    expect(res.status).toBe(200);

    const after = await anon()
      .get('/api/clients')
      .set('Authorization', `Bearer ${otherDevice}`);

    expect(after.status).toBe(401);

    const reloaded = await reload(admin.id);
    expect(reloaded.tokenVersion).toBe(1);
  });

  it('logout-all needs a session of its own', async () => {
    const res = await anon().post('/api/auth/logout-all');

    expect(res.status).toBe(401);
  });

  it('one user logging out everywhere does not touch another', async () => {
    const admin = await makeAdmin();
    const { user: other } = await makeClient();
    const otherToken = tokenFor(other);

    await as(admin).post('/api/auth/logout-all');

    const res = await anon()
      .get('/api/clients/me')
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(200);
  });
});
