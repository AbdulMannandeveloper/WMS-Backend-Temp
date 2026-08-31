/**
 * Sending mail over Brevo's HTTP API.
 *
 * Render's free tier blocks outbound SMTP entirely — ports 25, 465 and 587 —
 * so a direct connection cannot work there however correct the credentials
 * are. An HTTP API is an ordinary HTTPS request and is unaffected.
 *
 * fetch is stubbed throughout: these assert the request that would be sent and
 * how each kind of refusal is handled, without touching the network. Whether
 * the account is verified and the key valid is not something a test can know —
 * that is the manual check in the guide.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import mailer from '../../utils/mailer.js';

const { sendMail, buildBrevoPayload, describeMailTransport, BREVO_ENDPOINT } = mailer;

const withEnv = (vars, fn) => {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    process.env = saved;
  });
};

/** Brevo configured and working. */
const configured = {
  MAIL_TRANSPORT: 'brevo',
  BREVO_API_KEY: 'test-key-abc123',
  MAIL_FROM: 'noreply@propackers.uk',
  MAIL_FROM_NAME: 'ProPackers UK',
};

const okResponse = () => ({
  ok: true,
  status: 201,
  json: async () => ({ messageId: '<abc@brevo>' }),
});

const errorResponse = (status, body) => ({
  ok: false,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the request Brevo receives', () => {
  it('posts to the transactional endpoint with the api key', async () => {
    await withEnv(configured, async () => {
      await sendMail({ to: 'a@example.test', subject: 'Hi', text: 'body' });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(BREVO_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers['api-key']).toBe('test-key-abc123');
  });

  it('nests sender and recipient the way the API expects', async () => {
    // Easy to get subtly wrong, and the failure is a 400 at runtime rather than
    // anything visible in review.
    const payload = await withEnv(configured, () =>
      buildBrevoPayload({ to: 'a@example.test', subject: 'Hi', text: 'body' })
    );

    expect(payload.sender).toEqual({
      email: 'noreply@propackers.uk',
      name: 'ProPackers UK',
    });
    expect(payload.to).toEqual([{ email: 'a@example.test' }]);
    expect(payload.subject).toBe('Hi');
  });

  it('sends both bodies when both exist', async () => {
    const payload = await withEnv(configured, () =>
      buildBrevoPayload({ to: 'a@example.test', subject: 'Hi', html: '<p>hi</p>', text: 'hi' })
    );

    expect(payload.htmlContent).toBe('<p>hi</p>');
    expect(payload.textContent).toBe('hi');
  });

  it('omits a body it does not have, rather than sending an empty one', async () => {
    const payload = await withEnv(configured, () =>
      buildBrevoPayload({ to: 'a@example.test', subject: 'Hi', text: 'hi' })
    );

    expect(payload).not.toHaveProperty('htmlContent');
    expect(payload.textContent).toBe('hi');
  });

  it('gives up rather than hanging the queue', async () => {
    // A request with no timeout blocks every queued email behind it.
    await withEnv(configured, async () => {
      await sendMail({ to: 'a@example.test', subject: 'Hi', text: 'body' });
    });

    expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
  });
});

describe('when Brevo refuses', () => {
  it('reports the reason it gave', async () => {
    // "unrecognised sender" and "invalid key" look identical without this, and
    // the first is the one that actually happens.
    const errors = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.join(' '));
    });

    fetchMock.mockResolvedValue(
      errorResponse(400, { message: 'sender not valid', code: 'invalid_parameter' })
    );

    const sent = await withEnv(configured, () =>
      sendMail({ to: 'a@example.test', subject: 'Hi', text: 'body' })
    );

    expect(sent).toBe(false);
    expect(errors.join(' ')).toContain('sender not valid');
    spy.mockRestore();
  });

  it('never logs the api key', async () => {
    const errors = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.join(' '));
    });

    fetchMock.mockResolvedValue(errorResponse(401, { message: 'Key not found' }));

    await withEnv(configured, () =>
      sendMail({ to: 'a@example.test', subject: 'Hi', text: 'body' })
    );

    expect(errors.join(' ')).not.toContain('test-key-abc123');
    spy.mockRestore();
  });

  it('returns false so the queue retries rather than dropping the message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('network down'));

    const sent = await withEnv(configured, () =>
      sendMail({ to: 'a@example.test', subject: 'Hi', text: 'body' })
    );

    expect(sent).toBe(false);
    spy.mockRestore();
  });

  it('fails clearly when the key is missing entirely', async () => {
    const errors = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.join(' '));
    });

    const sent = await withEnv(
      { ...configured, BREVO_API_KEY: undefined },
      () => sendMail({ to: 'a@example.test', subject: 'Hi', text: 'body' })
    );

    expect(sent).toBe(false);
    expect(errors.join(' ')).toMatch(/BREVO_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refuses a message with no body at all', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const sent = await withEnv(configured, () =>
      sendMail({ to: 'a@example.test', subject: 'Empty' })
    );

    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the other transports still work', () => {
  it('mock mode sends nothing over the network', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const sent = await withEnv({ MAIL_TRANSPORT: undefined }, () =>
      sendMail({ to: 'a@example.test', subject: 'Hi', text: 'body' })
    );

    expect(sent).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('smtp mode does not go near the HTTP API', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await withEnv({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: undefined }, () =>
      sendMail({ to: 'a@example.test', subject: 'Hi', text: 'body' })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('what the server announces at boot', () => {
  it('warns loudly when nothing is configured', async () => {
    // The default is to send nothing. That is fine in development and a silent
    // failure in production, so it gets one loud line either way.
    const line = await withEnv({ MAIL_TRANSPORT: undefined }, () =>
      describeMailTransport()
    );

    expect(line).toMatch(/NO EMAIL WILL BE SENT/);
  });

  it('is blunter about it in production', async () => {
    const line = await withEnv(
      { MAIL_TRANSPORT: undefined, NODE_ENV: 'production' },
      () => describeMailTransport()
    );

    expect(line).toMatch(/wrong in production/i);
  });

  it('warns when brevo is chosen without a key', async () => {
    const line = await withEnv(
      { MAIL_TRANSPORT: 'brevo', BREVO_API_KEY: undefined },
      () => describeMailTransport()
    );

    expect(line).toMatch(/BREVO_API_KEY is not set/);
  });

  it('confirms the sending address when it is set up', async () => {
    const line = await withEnv(configured, () => describeMailTransport());

    expect(line).toContain('Brevo');
    expect(line).toContain('noreply@propackers.uk');
  });

  it('never prints the api key', async () => {
    const line = await withEnv(configured, () => describeMailTransport());
    expect(line).not.toContain('test-key-abc123');
  });
});
