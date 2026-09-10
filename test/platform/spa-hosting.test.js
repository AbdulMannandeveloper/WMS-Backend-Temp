/**
 * Serving the front end from this service, so the session cookie is first-party.
 *
 * Split across two hosts the refresh cookie is third-party, and iOS Safari,
 * Firefox and every private window drop it: the user signs in, the cookie never
 * lands, and the next request bounces them to the login screen. Served from one
 * origin it is an ordinary cookie and the whole class of problem goes away.
 *
 * The two things worth pinning are the boundaries, because getting either wrong
 * is quiet rather than loud:
 *
 *  - the SPA fallback must not swallow /api. An unknown API path answering with
 *    an HTML page turns a clean 404 into "Unexpected token '<'" wherever the
 *    response is parsed, which is a much longer afternoon.
 *  - with no build present this has to stay a pure API, or every API-only
 *    deployment starts answering HTML.
 *
 * The module reads the filesystem once at import, so each mode needs its own
 * module registry — hence resetModules and a fixture directory rather than a
 * mock.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const INDEX_HTML = '<!doctype html><html><head><title>Pro Packers UK</title></head><body><div id="root"></div></body></html>';

let distDir;

/** Imports a fresh copy of the app with FRONTEND_DIST pointed wherever we say. */
const loadApp = async (dir) => {
  vi.resetModules();
  const previous = process.env.FRONTEND_DIST;
  process.env.FRONTEND_DIST = dir;
  try {
    // A plain specifier: Vite cannot resolve a variable one, and resetModules
    // above is what makes this re-evaluate rather than hand back the cached app.
    const mod = await import('../../app.js');
    return mod.default.app;
  } finally {
    if (previous === undefined) delete process.env.FRONTEND_DIST;
    else process.env.FRONTEND_DIST = previous;
  }
};

beforeAll(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dist-'));
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(distDir, 'assets', 'index-abc123.js'), 'console.log(1)');
});

afterAll(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
});

describe('with a front-end build present', () => {
  it('serves the app at the root', async () => {
    const app = await loadApp(distDir);

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('id="root"');
  });

  it('serves the app for a client-side route', async () => {
    // The failure this exists for: a bookmark or a refresh on /app/inventory
    // returning 404, or a blank page, because the path is not a file.
    const app = await loadApp(distDir);

    for (const route of ['/auth/login', '/app/inventory', '/client/shipments', '/setup-password']) {
      const res = await request(app).get(route);
      expect(res.status, route).toBe(200);
      expect(res.text, route).toContain('id="root"');
    }
  });

  it('still answers JSON for an unknown API path', async () => {
    // The boundary. HTML here would be parsed as JSON by every caller.
    const app = await loadApp(distDir);

    const res = await request(app).get('/api/there-is-no-such-thing');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.message).toMatch(/Route not found/);
  });

  it('still answers JSON for an unknown API path under a real router', async () => {
    const app = await loadApp(distDir);

    const res = await request(app).get('/api/shipments/nope/nope/nope');

    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.text).not.toContain('id="root"');
  });

  it('does not hand a page back for a non-GET', async () => {
    // A POST to a path that does not exist is a mistake worth reporting, not a
    // navigation.
    const app = await loadApp(distDir);

    const res = await request(app).post('/not-a-real-endpoint');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('moves the API banner out of the root', async () => {
    const app = await loadApp(distDir);

    const res = await request(app).get('/api');

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/API is running/);
  });

  it('leaves the health probes alone', async () => {
    // An orchestrator polling /healthz must never get an HTML page.
    const app = await loadApp(distDir);

    const res = await request(app).get('/healthz');

    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.status).toBe('ok');
  });

  it('lets fingerprinted assets be cached forever, and index.html never', async () => {
    // A cached index.html points at asset filenames that stop existing at the
    // next deploy, and the app fails to boot with nothing on screen to say why.
    const app = await loadApp(distDir);

    const asset = await request(app).get('/assets/index-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toMatch(/immutable/);

    const page = await request(app).get('/');
    expect(page.headers['cache-control']).toMatch(/no-store/);
  });
});

describe('with no front-end build', () => {
  it('stays a pure API', async () => {
    const app = await loadApp(path.join(distDir, 'does-not-exist'));

    const root = await request(app).get('/');
    expect(root.headers['content-type']).toMatch(/json/);
    expect(root.body.message).toMatch(/API is running/);

    const missing = await request(app).get('/auth/login');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toMatch(/json/);
  });
});
