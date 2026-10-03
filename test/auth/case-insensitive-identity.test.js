/**
 * Emails, usernames and NI numbers mean the same thing whatever the case.
 *
 * Postgres compares text exactly. Before this, someone whose address was stored
 * as `Jo@Acme.com` could not sign in by typing `jo@acme.com`, forgot-password
 * quietly sent them nothing (it answers 200 either way, by design), and the
 * duplicate check let the same mailbox own two accounts. All of it looked like
 * "wrong password" to the person on the other end.
 *
 * The fix is one stored spelling (utils/identifiers.js), applied in the user
 * repository so no path can skip it, and held by CHECK constraints so one that
 * writes around the repository fails rather than storing an unreachable row.
 */

import { describe, it, expect } from 'vitest';
import bcrypt from 'bcrypt';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import { makeAdmin, makeUser, makeEmployee } from '../factories/index.js';

const PASSWORD = 'correct horse battery';

/** A login that has finished setup and can sign in with PASSWORD. */
const makeSignedUpUser = async (overrides = {}) =>
  makeUser({
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    isActive: true,
    ...overrides,
  });

describe('signing in', () => {
  it('accepts the email in a different case', async () => {
    const user = await makeSignedUpUser({ email: 'jo.bloggs@example.test' });

    const res = await anon()
      .post('/api/auth/login')
      .send({ identifier: 'Jo.Bloggs@EXAMPLE.test', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(user.id);
  });

  it('accepts the email with stray spaces around it', async () => {
    // Autofill and copy-paste both add them, and the field shows nothing wrong.
    const user = await makeSignedUpUser({ email: 'padded@example.test' });

    const res = await anon()
      .post('/api/auth/login')
      .send({ identifier: '  padded@example.test ', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(user.id);
  });

  it('accepts the username in a different case', async () => {
    const user = await makeSignedUpUser({ username: 'jbloggs' });

    const res = await anon()
      .post('/api/auth/login')
      .send({ identifier: 'JBloggs', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(user.id);
  });

  it('still refuses the wrong password', async () => {
    // Matching more loosely must not mean checking less.
    await makeSignedUpUser({ email: 'guarded@example.test' });

    const res = await anon()
      .post('/api/auth/login')
      .send({ identifier: 'GUARDED@example.test', password: 'not the password' });

    expect(res.status).not.toBe(200);
    expect(res.body.error).toMatch(/invalid credentials/i);
  });
});

describe('forgot password', () => {
  it('issues a reset link for the email in a different case', async () => {
    // The response is 200 whether or not the account exists, so the token is
    // the only evidence the right person was found.
    const user = await makeSignedUpUser({ email: 'forgetful@example.test' });

    const res = await anon()
      .post('/api/auth/forgot-password')
      .send({ email: 'Forgetful@Example.TEST' });

    expect(res.status).toBe(200);
    const tokens = await prisma.invitationToken.count({ where: { userId: user.id } });
    expect(tokens).toBe(1);
  });
});

describe('creating logins', () => {
  it('stores the email and username in lowercase', async () => {
    const admin = await makeAdmin();

    const res = await as(admin).post('/api/users/add').send({
      firstName: 'Mixed',
      lastName: 'Case',
      email: '  Mixed.Case@Example.TEST ',
      username: ' MixedCase ',
    });

    expect(res.status).toBe(201);
    const row = await prisma.user.findUnique({ where: { id: res.body.id } });
    expect(row.email).toBe('mixed.case@example.test');
    expect(row.username).toBe('mixedcase');
  });

  it('refuses an email that only differs in case from an existing one', async () => {
    const admin = await makeAdmin();
    await makeUser({ email: 'taken@example.test' });

    const res = await as(admin)
      .post('/api/users/add')
      .send({ firstName: 'Copy', lastName: 'Cat', email: 'Taken@Example.test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/i);
    const count = await prisma.user.count({
      where: { email: { equals: 'taken@example.test', mode: 'insensitive' } },
    });
    expect(count).toBe(1);
  });

  it('refuses the same check when adding a client', async () => {
    const admin = await makeAdmin();
    await makeUser({ email: 'shared-inbox@example.test' });

    const res = await as(admin).post('/api/clients').send({
      companyName: 'Second Co',
      contactName: 'Sam Second',
      email: 'Shared-Inbox@example.test',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('keeps a new client contact email in the same spelling as its login', async () => {
    // The two are edited together and compared to decide whether the login
    // changes too; differing in case would read as a change every time.
    const admin = await makeAdmin();

    const res = await as(admin).post('/api/clients').send({
      companyName: 'Case Co',
      contactName: 'Casey Case',
      email: 'Casey@CaseCo.example',
    });

    expect(res.status).toBe(201);
    const user = await prisma.user.findUnique({ where: { id: res.body.userId } });
    const client = await prisma.client.findUnique({ where: { id: res.body.clientId } });
    expect(user.email).toBe('casey@caseco.example');
    expect(client.email).toBe('casey@caseco.example');
  });
});

describe('editing logins', () => {
  it('names the clash when a username is taken in another case', async () => {
    // Nothing checks username before writing, so the unique index has the
    // last word. It used to answer with Prisma's constraint dump.
    const admin = await makeAdmin();
    await makeUser({ username: 'warehouse1' });
    const other = await makeUser();

    const res = await as(admin).put(`/api/users/${other.id}`).send({ username: 'Warehouse1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('That username is already taken.');
  });

  it('names the clash when an email is taken in another case', async () => {
    const admin = await makeAdmin();
    await makeUser({ email: 'first@example.test' });
    const other = await makeUser();

    const res = await as(admin).put(`/api/users/${other.id}`).send({ email: 'First@Example.test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A user with this email already exists.');
  });

  it('treats a client email change in case only as no change at all', async () => {
    const admin = await makeAdmin();
    const created = await as(admin).post('/api/clients').send({
      companyName: 'Steady Co',
      contactName: 'Stan Steady',
      email: 'stan@steady.example',
    });

    const res = await as(admin)
      .put(`/api/clients/${created.body.clientId}`)
      .send({ email: 'Stan@Steady.example' });

    expect(res.status).toBe(200);
    const user = await prisma.user.findUnique({ where: { id: created.body.userId } });
    expect(user.email).toBe('stan@steady.example');
  });
});

describe('National Insurance numbers', () => {
  it('are stored uppercase without spaces', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();

    const res = await as(admin)
      .put(`/api/employees/${employee.id}`)
      .send({ nationalInsuranceNumber: 'qq 12 34 56 c' });

    expect(res.status).toBe(200);
    const after = await prisma.employee.findUnique({ where: { id: employee.id } });
    expect(after.nationalInsuranceNumber).toBe('QQ123456C');
  });

  it('are recognised as already on file whatever the spelling', async () => {
    const admin = await makeAdmin();
    await makeEmployee({ nationalInsuranceNumber: 'QQ444444D' });
    const { employee } = await makeEmployee();

    const res = await as(admin)
      .put(`/api/employees/${employee.id}`)
      .send({ nationalInsuranceNumber: 'qq 44 44 44 d' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already recorded against another employee/i);
  });
});

describe('the database rule', () => {
  // A write that goes around the repository must fail, not store a row that no
  // lookup will ever find.
  it('refuses an email that is not lowercase', async () => {
    await expect(makeUser({ email: 'Shouty@Example.test' })).rejects.toThrow(
      /ck_users_email_canonical/,
    );
  });

  it('refuses a username that is not lowercase', async () => {
    await expect(makeUser({ username: 'Shouty' })).rejects.toThrow(
      /ck_users_username_canonical/,
    );
  });

  it('refuses an NI number with spaces in it', async () => {
    await expect(makeEmployee({ nationalInsuranceNumber: 'QQ 55 55 55 E' })).rejects.toThrow(
      /ck_employees_ni_number_canonical/,
    );
  });
});
