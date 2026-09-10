/**
 * Who the API answers, and what a refusal looks like.
 *
 * Both of these were found by actually running the app with the front end
 * served from it, which is the configuration the cross-site cookie fix needs.
 *
 * A browser attaches an Origin header to same-origin POSTs, not just
 * cross-origin ones. So the moment this service serves the app as well as the
 * API, every call arrives carrying this service's own origin — which is not in
 * CORS_ORIGINS, because nobody lists themselves. Every request 500'd.
 *
 * And it 500'd rather than being refused, because the origin callback threw:
 * the error reached the handler at the bottom of app.js and became "Internal
 * server error", which reads as the server falling over rather than as a rule
 * being applied.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import appModule from '../../app.js';

const { app } = appModule;

describe('a same-origin request', () => {
  it('is allowed, whatever CORS_ORIGINS says', async () => {
    // The regression. supertest serves on an ephemeral port, so the Origin is
    // built from the address the request actually arrives on — exactly what a
    // browser does when the page and the API share a host.
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const res = await request(server)
        .get('/healthz')
        .set('Origin', `http://127.0.0.1:${port}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    } finally {
      server.close();
    }
  });

  it('does not 500 a POST from its own origin', async () => {
    // The shape of the real failure: login and refresh are POSTs, and a POST is
    // exactly where the browser sends Origin on a same-origin call.
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const res = await request(server)
        .post('/api/auth/refresh')
        .set('Origin', `http://127.0.0.1:${port}`);

      // 401 because there is no cookie — the point is that it reached the route
      // and answered as itself, rather than dying in the CORS middleware.
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/json/);
    } finally {
      server.close();
    }
  });
});

describe('a request with no Origin at all', () => {
  it('is allowed — curl, a health probe, a server-to-server call', async () => {
    const res = await request(app).get('/healthz');

    expect(res.status).toBe(200);
  });
});

describe('a configured origin', () => {
  it('is allowed and echoed back with credentials', async () => {
    // CORS_ORIGINS defaults to the Vite dev server, which is the split-origin
    // development setup.
    const res = await request(app)
      .get('/healthz')
      .set('Origin', 'http://localhost:5173');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('an origin that is not allowed', () => {
  it('is refused by omitting the headers, not by failing', async () => {
    // The browser is what enforces this, and it enforces by the absence of the
    // header. Throwing here produced a 500 and a stack trace per request.
    const res = await request(app)
      .get('/healthz')
      .set('Origin', 'https://not-our-site.example');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never produces a 500', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Origin', 'https://not-our-site.example');

    expect(res.status).not.toBe(500);
  });
});
