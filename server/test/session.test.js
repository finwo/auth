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
  getSessionRealmBinding,
  listSessionAccounts,
  reauthenticateSession,
  revokeRealmSessions,
  revokeSessionRealm,
  selectSessionAccount,
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

test('disabling the active account keeps other accounts in the group', async () => {
  const { dir, realm, systemDb, userId } = await setup();
  try {
    const context = realmContext(realm);
    const first = await createHostSession(systemDb, {
      context,
      userId,
      ttl: SHORT_SESSION_TTL,
    });
    const otherId = await createUser(systemDb, { username: 'bob', displayName: 'Bob' });
    const second = await createHostSession(systemDb, {
      context,
      token: first.token,
      userId: otherId,
      ttl: SHORT_SESSION_TTL,
    });

    await systemDb.run('UPDATE users SET status = {status} WHERE id = {id}', {
      status: 'disabled',
      id: otherId,
    });

    const res = mockResponse();
    assert.equal(
      await authenticateRequest({
        systemDb,
        realmDb: null,
        req: mockRequest(`${SESSION_COOKIE}=${first.token}`),
        res,
        context,
      }),
      null
    );

    const found = await getSessionByToken(systemDb, first.token);
    assert.equal(found.session.user_id, userId);

    const accounts = await listSessionAccounts(systemDb, second.group);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].user.id, userId);
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

test('the same user reuses a session and a different user adds an account', async () => {
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
    assert.equal(second.token, first.token);
    assert.equal(second.session.id, first.session.id);

    const otherId = await createUser(systemDb, { username: 'bob', displayName: 'Bob' });
    const third = await createHostSession(systemDb, {
      context,
      token: first.token,
      userId: otherId,
      ttl: SHORT_SESSION_TTL,
    });
    assert.equal(third.group.id, first.group.id);
    assert.equal(third.token, first.token);
    assert.equal(third.session.user_id, otherId);

    const old = await systemDb.get('SELECT id FROM sessions WHERE id = {id}', {
      id: first.session.id,
    });
    assert.equal(old.id, first.session.id);

    const accounts = await listSessionAccounts(systemDb, third.group);
    assert.deepEqual(
      accounts.map((account) => account.user.username),
      ['alice', 'bob']
    );
    assert.equal(accounts.find((account) => account.user.id === otherId).active, true);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('selecting an account updates the active session', async () => {
  const { dir, realm, systemDb, userId } = await setup();
  try {
    const context = realmContext(realm);
    const first = await createHostSession(systemDb, {
      context,
      userId,
      ttl: SHORT_SESSION_TTL,
    });
    const otherId = await createUser(systemDb, { username: 'bob', displayName: 'Bob' });
    const second = await createHostSession(systemDb, {
      context,
      token: first.token,
      userId: otherId,
      ttl: SHORT_SESSION_TTL,
    });

    const selected = await selectSessionAccount(systemDb, {
      token: first.token,
      context,
      publicId: first.session.public_id,
    });
    assert.equal(selected.user.id, userId);
    assert.equal(selected.session.id, first.session.id);

    const found = await getSessionByToken(systemDb, first.token);
    assert.equal(found.session.id, first.session.id);

    const rejectedHost = await selectSessionAccount(systemDb, {
      token: first.token,
      context: clientContext(realm),
      publicId: second.session.public_id,
    });
    assert.equal(rejectedHost, null);

    const rejectedAccount = await selectSessionAccount(systemDb, {
      token: first.token,
      context,
      publicId: 'missing',
    });
    assert.equal(rejectedAccount, null);
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

test('logout keeps the group when another account remains', async () => {
  const { dir, realm, systemDb, userId } = await setup();
  try {
    const context = realmContext(realm);
    const first = await createHostSession(systemDb, {
      context,
      userId,
      ttl: SHORT_SESSION_TTL,
    });
    const otherId = await createUser(systemDb, { username: 'bob', displayName: 'Bob' });
    const second = await createHostSession(systemDb, {
      context,
      token: first.token,
      userId: otherId,
      ttl: SHORT_SESSION_TTL,
    });

    const result = await destroySession(systemDb, first.token);
    assert.equal(result.groupDeleted, false);

    const found = await getSessionByToken(systemDb, first.token);
    assert.equal(found.session.id, first.session.id);

    const accounts = await listSessionAccounts(systemDb, second.group);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].user.id, userId);
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

test('revoking one session realm leaves other realm bindings intact', async () => {
  const { dir, realm, systemDb, userId } = await setup();
  try {
    const other = await createRealm({ slug: 'globex', displayName: 'Globex' });
    const { session } = await createHostSession(systemDb, {
      context: canonicalContext(),
      userId,
      ttl: SHORT_SESSION_TTL,
    });

    await bindSessionRealm(systemDb, session.id, realm.id, 1000);
    await bindSessionRealm(systemDb, session.id, other.id, 1000);

    const revoked = await revokeSessionRealm(systemDb, {
      sessionId: session.id,
      realmId: realm.id,
      revokedBy: 'admin',
      now: 2000,
    });
    assert.equal(revoked.revoked_at, 2000);
    assert.equal(revoked.revoked_by, 'admin');

    const acme = await getSessionRealmBinding(systemDb, session.id, realm.id);
    assert.equal(acme.revoked_at, 2000);
    const globex = await getSessionRealmBinding(systemDb, session.id, other.id);
    assert.equal(globex.revoked_at, null);

    const again = await revokeSessionRealm(systemDb, {
      sessionId: session.id,
      realmId: realm.id,
      revokedBy: 'second-admin',
      now: 3000,
    });
    assert.equal(again.revoked_at, 2000);
    assert.equal(again.revoked_by, 'admin');
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('revoking an unbound session realm creates a revoked binding', async () => {
  const { dir, realm, systemDb, userId } = await setup();
  try {
    const { session } = await createHostSession(systemDb, {
      context: canonicalContext(),
      userId,
      ttl: SHORT_SESSION_TTL,
    });

    await revokeSessionRealm(systemDb, {
      sessionId: session.id,
      realmId: realm.id,
      revokedBy: 'admin',
      now: 4000,
    });

    const binding = await getSessionRealmBinding(systemDb, session.id, realm.id);
    assert.equal(binding.created_at, 4000);
    assert.equal(binding.last_seen_at, 4000);
    assert.equal(binding.revoked_at, 4000);
    assert.equal(binding.revoked_by, 'admin');
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('revoking a realm marks every unrevoked binding for that realm', async () => {
  const { dir, realm, systemDb, userId } = await setup();
  try {
    const other = await createRealm({ slug: 'globex', displayName: 'Globex' });
    const first = await createHostSession(systemDb, {
      context: canonicalContext('identity.test'),
      userId,
      ttl: SHORT_SESSION_TTL,
    });
    const second = await createHostSession(systemDb, {
      context: canonicalContext('other-identity.test'),
      userId,
      ttl: SHORT_SESSION_TTL,
    });

    await bindSessionRealm(systemDb, first.session.id, realm.id, 1000);
    await bindSessionRealm(systemDb, first.session.id, other.id, 1000);
    await bindSessionRealm(systemDb, second.session.id, realm.id, 1000);

    const changed = await revokeRealmSessions(systemDb, {
      realmId: realm.id,
      revokedBy: 'admin',
      now: 5000,
    });
    assert.equal(changed, 2);

    const firstAcme = await getSessionRealmBinding(systemDb, first.session.id, realm.id);
    const secondAcme = await getSessionRealmBinding(systemDb, second.session.id, realm.id);
    const firstGlobex = await getSessionRealmBinding(systemDb, first.session.id, other.id);
    assert.equal(firstAcme.revoked_at, 5000);
    assert.equal(secondAcme.revoked_at, 5000);
    assert.equal(firstGlobex.revoked_at, null);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('reauthentication clears only the target realm and refreshes auth_time', async () => {
  const { dir, realm, systemDb, userId } = await setup();
  try {
    const other = await createRealm({ slug: 'globex', displayName: 'Globex' });
    const { session } = await createHostSession(systemDb, {
      context: canonicalContext(),
      userId,
      ttl: SHORT_SESSION_TTL,
    });

    await bindSessionRealm(systemDb, session.id, realm.id, 1000);
    await bindSessionRealm(systemDb, session.id, other.id, 1000);
    await revokeSessionRealm(systemDb, {
      sessionId: session.id,
      realmId: realm.id,
      revokedBy: 'admin',
      now: 2000,
    });
    await revokeSessionRealm(systemDb, {
      sessionId: session.id,
      realmId: other.id,
      revokedBy: 'admin',
      now: 2000,
    });

    const authTime = await reauthenticateSession(systemDb, {
      sessionId: session.id,
      realmId: realm.id,
      now: 9000,
    });
    assert.equal(authTime, 9);

    const acme = await getSessionRealmBinding(systemDb, session.id, realm.id);
    const globex = await getSessionRealmBinding(systemDb, session.id, other.id);
    assert.equal(acme.revoked_at, null);
    assert.equal(acme.revoked_by, null);
    assert.equal(acme.last_seen_at, 9000);
    assert.equal(globex.revoked_at, 2000);

    const updated = await systemDb.get(
      'SELECT auth_time, last_seen_at FROM sessions WHERE id = {id}',
      { id: session.id }
    );
    assert.equal(updated.auth_time, 9);
    assert.equal(updated.last_seen_at, 9000);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('binding a revoked realm does not clear the revocation', async () => {
  const { dir, realm, systemDb, userId } = await setup();
  try {
    const { session } = await createHostSession(systemDb, {
      context: canonicalContext(),
      userId,
      ttl: SHORT_SESSION_TTL,
    });

    await bindSessionRealm(systemDb, session.id, realm.id, 1000);
    await revokeSessionRealm(systemDb, {
      sessionId: session.id,
      realmId: realm.id,
      revokedBy: 'admin',
      now: 2000,
    });
    await bindSessionRealm(systemDb, session.id, realm.id, 3000);

    const binding = await getSessionRealmBinding(systemDb, session.id, realm.id);
    assert.equal(binding.revoked_at, 2000);
    assert.equal(binding.last_seen_at, 1000);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
