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
  SESSION_COOKIE,
  SHORT_SESSION_TTL,
  authenticateRequest,
  bindSessionRealm,
  createHostSession,
  destroySession,
  getSessionByToken,
} from '../src/lib/session.js';
import { createUser, ensureMembership } from '../src/lib/users.js';

function realmContext(realm, host = 'acme.localhost') {
  return { mode: 'realm', host, realm };
}

function clientContext(realm, host = 'app.acme.localhost', clientId = 'internal-app') {
  return { mode: 'client', host, realm, clientId };
}

function canonicalContext(host = 'identity.test') {
  return { mode: 'canonical', host };
}

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

test('sessions store only the group token hash and authenticate the user', async () => {
  const { dir, realm, realmDb, systemDb, userId } = await setup();
  try {
    const context = realmContext(realm);
    const { token, group, session } = await createHostSession(systemDb, {
      context,
      userId,
      ttl: SHORT_SESSION_TTL,
      userAgent: 'test',
      ip: '127.0.0.1',
    });
    const id = crypto.createHash('sha256').update(token).digest('hex');

    assert.equal(group.id, id);
    assert.notEqual(session.public_id, token);

    const found = await getSessionByToken(systemDb, token);
    assert.equal(found.session.id, session.id);

    const req = mockRequest(`${SESSION_COOKIE}=${token}`);
    const res = mockResponse();
    const auth = await authenticateRequest({
      systemDb,
      realmDb,
      req,
      res,
      context,
    });
    assert.equal(auth.user.id, userId);
    assert.equal(auth.membership.status, 'active');
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('host scopes are stored from the request context', async () => {
  const { dir, realm, systemDb, userId } = await setup();
  try {
    const global = await createHostSession(systemDb, {
      context: canonicalContext(),
      userId,
      ttl: SHORT_SESSION_TTL,
    });
    assert.equal(global.session.scope_type, 'global');
    assert.equal(global.session.scope_host, 'identity.test');
    assert.equal(global.session.realm_id, null);

    const client = await createHostSession(systemDb, {
      context: clientContext(realm),
      userId,
      ttl: SHORT_SESSION_TTL,
    });
    assert.equal(client.session.scope_type, 'client');
    assert.equal(client.session.scope_host, 'app.acme.localhost');
    assert.equal(client.session.realm_id, realm.id);
    assert.equal(client.session.client_id, 'internal-app');
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sliding sessions extend expiry and reissue the cookie', async () => {
  const { dir, realm, realmDb, systemDb, userId } = await setup();
  try {
    const context = realmContext(realm);
    const { token, session } = await createHostSession(
      systemDb,
      { context, userId, ttl: SHORT_SESSION_TTL },
      1000
    );
    const req = mockRequest(`${SESSION_COOKIE}=${token}`);
    const res = mockResponse();

    await authenticateRequest({
      systemDb,
      realmDb,
      req,
      res,
      context,
      now: 1000 + 61_000,
    });

    const updated = await systemDb.get(
      'SELECT expires_at, last_seen_at FROM sessions WHERE id = {id}',
      { id: session.id }
    );
    assert.equal(updated.expires_at, 1000 + 61_000 + SHORT_SESSION_TTL * 1000);
    assert.ok(res.getHeader('set-cookie'));
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('expired sessions are rejected and their group is removed', async () => {
  const { dir, realm, realmDb, systemDb, userId } = await setup();
  try {
    const context = realmContext(realm);
    const { token, group } = await createHostSession(
      systemDb,
      { context, userId, ttl: 1 },
      1000
    );

    assert.equal(await getSessionByToken(systemDb, token, 3000), null);
    await authenticateRequest({
      systemDb,
      realmDb,
      req: mockRequest(`${SESSION_COOKIE}=${token}`),
      res: mockResponse(),
      context,
      now: 3000,
    });
    const row = await systemDb.get('SELECT id FROM session_groups WHERE id = {id}', {
      id: group.id,
    });
    assert.equal(row, undefined);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('disabled users lose access and their session group is removed', async () => {
  const { dir, realm, realmDb, systemDb, userId } = await setup();
  try {
    const context = realmContext(realm);
    const { token, group } = await createHostSession(systemDb, {
      context,
      userId,
      ttl: SHORT_SESSION_TTL,
    });

    await systemDb.run('UPDATE users SET status = {status} WHERE id = {id}', {
      status: 'disabled',
      id: userId,
    });
    assert.equal(
      await authenticateRequest({
        systemDb,
        realmDb,
        req: mockRequest(`${SESSION_COOKIE}=${token}`),
        res: mockResponse(),
        context,
      }),
      null
    );

    const row = await systemDb.get('SELECT id FROM session_groups WHERE id = {id}', {
      id: group.id,
    });
    assert.equal(row, undefined);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a session is rejected on a different host scope', async () => {
  const { dir, realm, realmDb, systemDb, userId } = await setup();
  try {
    const context = realmContext(realm);
    const { token, group } = await createHostSession(systemDb, {
      context,
      userId,
      ttl: SHORT_SESSION_TTL,
    });

    assert.equal(
      await authenticateRequest({
        systemDb,
        realmDb,
        req: mockRequest(`${SESSION_COOKIE}=${token}`),
        res: mockResponse(),
        context: clientContext(realm),
      }),
      null
    );

    const row = await systemDb.get('SELECT id FROM session_groups WHERE id = {id}', {
      id: group.id,
    });
    assert.equal(row.id, group.id);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the same user reuses a group and a different user replaces it', async () => {
  const { dir, realm, systemDb, userId } = await setup();
  try {
    const context = realmContext(realm);
    const first = await createHostSession(systemDb, {
      context,
      userId,
      ttl: SHORT_SESSION_TTL,
    });
    const second = await createHostSession(systemDb, {
      context,
      token: first.token,
      userId,
      ttl: SHORT_SESSION_TTL,
    });
    assert.equal(second.group.id, first.group.id);
    assert.equal(second.session.id, first.session.id);

    const otherId = await createUser(systemDb, { username: 'bob', displayName: 'Bob' });
    const third = await createHostSession(systemDb, {
      context,
      token: first.token,
      userId: otherId,
      ttl: SHORT_SESSION_TTL,
    });
    assert.notEqual(third.group.id, first.group.id);
    assert.equal(third.session.user_id, otherId);

    const old = await systemDb.get('SELECT id FROM sessions WHERE id = {id}', {
      id: first.session.id,
    });
    assert.equal(old, undefined);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('logout deletes the active session and group', async () => {
  const { dir, realm, systemDb, userId } = await setup();
  try {
    const { token, group } = await createHostSession(systemDb, {
      context: realmContext(realm),
      userId,
      ttl: SHORT_SESSION_TTL,
    });

    const result = await destroySession(systemDb, token);
    assert.equal(result.groupDeleted, true);
    assert.equal(await getSessionByToken(systemDb, token), null);

    const row = await systemDb.get('SELECT id FROM session_groups WHERE id = {id}', {
      id: group.id,
    });
    assert.equal(row, undefined);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('realm bindings are inserted once and updated on repeat', async () => {
  const { dir, realm, systemDb, userId } = await setup();
  try {
    const { session } = await createHostSession(systemDb, {
      context: canonicalContext(),
      userId,
      ttl: SHORT_SESSION_TTL,
    });

    await bindSessionRealm(systemDb, session.id, realm.id, 1000);
    await bindSessionRealm(systemDb, session.id, realm.id, 2000);

    const rows = await systemDb.all(
      `SELECT session_id, realm_id, last_seen_at
         FROM session_realms
        WHERE session_id = {sessionId}`,
      { sessionId: session.id }
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].last_seen_at, 2000);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
