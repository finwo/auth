import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  closeRealms,
  createRealm,
  getSystemDatabase,
  initRealms,
  openRealmDatabase,
} from '../src/lib/realm.js';
import {
  SHORT_SESSION_TTL,
  authenticateRequest,
  createSession,
  destroySession,
  getSessionByToken,
  sessionCookieName,
} from '../src/lib/session.js';
import { createUser, ensureMembership } from '../src/lib/users.js';

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-session-'));
  const cfg = {
    database: {
      dialect: 'sqlite',
      path: path.join(dir, 'system.sqlite'),
      realms: path.join(dir, 'realms'),
    },
  };
  await initRealms(cfg);
  const realm = await createRealm({ slug: 'acme', displayName: 'Acme' });
  const realmDb = await openRealmDatabase(realm);
  const systemDb = getSystemDatabase();
  const userId = await createUser(systemDb, { username: 'alice', displayName: 'Alice' });
  await ensureMembership(realmDb, userId, 'active');
  return { dir, realm, realmDb, systemDb, userId };
}

function mockRequest(cookie = '') {
  return {
    headers: { cookie },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function mockResponse() {
  const headers = {};
  return {
    headers,
    getHeader(name) {
      return headers[name.toLowerCase()];
    },
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
  };
}

test('sessions store only the token hash and authenticate the user', async () => {
  const { dir, realm, realmDb, systemDb, userId } = await setup();
  try {
    const { token } = await createSession(realmDb, {
      userId,
      ttl: SHORT_SESSION_TTL,
      userAgent: 'test',
      ip: '127.0.0.1',
    });
    const id = crypto.createHash('sha256').update(token).digest('hex');

    const session = await getSessionByToken(realmDb, token);
    assert.equal(session.id, id);
    assert.notEqual(session.id, token);

    const req = mockRequest(`${sessionCookieName(realm)}=${token}`);
    const res = mockResponse();
    const auth = await authenticateRequest({ systemDb, realmDb, req, res, realm });
    assert.equal(auth.user.id, userId);
    assert.equal(auth.membership.status, 'active');
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sliding sessions extend expiry and reissue the cookie', async () => {
  const { dir, realm, realmDb, systemDb, userId } = await setup();
  try {
    const { token, session } = await createSession(
      realmDb,
      { userId, ttl: SHORT_SESSION_TTL },
      1000
    );
    const req = mockRequest(`${sessionCookieName(realm)}=${token}`);
    const res = mockResponse();

    await authenticateRequest({
      systemDb,
      realmDb,
      req,
      res,
      realm,
      now: 1000 + 61_000,
    });

    const updated = await realmDb.get('SELECT expires_at, last_seen_at FROM sessions WHERE id = {id}', {
      id: session.id,
    });
    assert.equal(updated.expires_at, 1000 + 61_000 + SHORT_SESSION_TTL * 1000);
    assert.ok(res.getHeader('set-cookie'));
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('expired sessions are rejected and removed', async () => {
  const { dir, realmDb, userId } = await setup();
  try {
    const { token, session } = await createSession(realmDb, { userId, ttl: 1 }, 1000);
    assert.equal(await getSessionByToken(realmDb, token, 3000), null);
    const row = await realmDb.get('SELECT id FROM sessions WHERE id = {id}', { id: session.id });
    assert.equal(row, undefined);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('disabled users and suspended memberships lose access', async () => {
  const { dir, realm, realmDb, systemDb, userId } = await setup();
  try {
    const { token } = await createSession(realmDb, { userId, ttl: SHORT_SESSION_TTL });
    const req = mockRequest(`${sessionCookieName(realm)}=${token}`);

    await systemDb.run('UPDATE users SET status = {status} WHERE id = {id}', {
      status: 'disabled',
      id: userId,
    });
    assert.equal(
      await authenticateRequest({ systemDb, realmDb, req, res: mockResponse(), realm }),
      null
    );

    await systemDb.run('UPDATE users SET status = {status} WHERE id = {id}', {
      status: 'active',
      id: userId,
    });
    await realmDb.run('UPDATE realm_memberships SET status = {status} WHERE user_id = {id}', {
      status: 'suspended',
      id: userId,
    });
    assert.equal(
      await authenticateRequest({ systemDb, realmDb, req, res: mockResponse(), realm }),
      null
    );
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('logout deletes the session', async () => {
  const { dir, realmDb, userId } = await setup();
  try {
    const { token } = await createSession(realmDb, { userId, ttl: SHORT_SESSION_TTL });
    await destroySession(realmDb, token);
    assert.equal(await getSessionByToken(realmDb, token), null);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
