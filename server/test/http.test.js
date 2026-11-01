import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createLocalJWKSet, jwtVerify } from 'jose';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function runNode(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: serverDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${script} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: serverDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0 && !stdout.includes('Listening on')) {
        reject(new Error(`server exited ${code}\n${stdout}\n${stderr}`));
      }
    });
    const deadline = Date.now() + 15_000;
    const timer = setInterval(() => {
      if (stdout.includes('Listening on')) {
        clearInterval(timer);
        resolve(child);
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        child.kill('SIGTERM');
        reject(new Error(`server did not start\n${stdout}\n${stderr}`));
      }
    }, 50);
  });
}

function request(
  port,
  { method = 'GET', path: requestPath = '/', host, body, form, cookie, bearer, headers: extraHeaders = {} } = {}
) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const headers = { host, ...extraHeaders };
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    } else if (form !== undefined) {
      payload = new URLSearchParams(form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (cookie) headers.cookie = cookie;
    if (bearer) headers.authorization = `Bearer ${bearer}`;

    const req = http.request(
      { host: '127.0.0.1', port, method, path: requestPath, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.once('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function responseCookies(response) {
  const values = response.headers['set-cookie'];
  return Array.isArray(values) ? values.map((value) => value.split(';')[0]) : [];
}

function mergeCookies(existing, response) {
  const jar = new Map();
  for (const pair of existing ? existing.split('; ') : []) {
    const index = pair.indexOf('=');
    if (index !== -1) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  for (const pair of responseCookies(response)) {
    const index = pair.indexOf('=');
    if (index !== -1) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function maxAge(response) {
  const values = response.headers['set-cookie'];
  if (!values || values.length === 0) return null;
  const match = /Max-Age=(\d+)/.exec(values[0]);
  return match ? Number(match[1]) : null;
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function locationQuery(response) {
  return new URL(response.headers.location, 'http://localhost');
}

function cookieValue(cookie, name) {
  const pair = cookie
    .split('; ')
    .find((value) => value.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : null;
}

function withSystemDatabase(env, fn) {
  const database = new DatabaseSync(env.AUTH_DATABASE_PATH);
  try {
    return fn(database);
  } finally {
    database.close();
  }
}

function activeSessionId(env, cookie) {
  const token = cookieValue(cookie, 'auth_session');
  const groupId = crypto.createHash('sha256').update(token).digest('hex');
  return withSystemDatabase(env, (database) => {
    const row = database
      .prepare('SELECT active_session_id FROM session_groups WHERE id = ?')
      .get(groupId);
    return row.active_session_id;
  });
}

function activeSessionPublicId(env, cookie) {
  const token = cookieValue(cookie, 'auth_session');
  const groupId = crypto.createHash('sha256').update(token).digest('hex');
  return withSystemDatabase(env, (database) => {
    const row = database
      .prepare(
        `SELECT s.public_id
           FROM sessions s
           JOIN session_groups g ON g.active_session_id = s.id
          WHERE g.id = ?`
      )
      .get(groupId);
    return row.public_id;
  });
}

function clearConsent(env, { username, realm, clientId }) {
  withSystemDatabase(env, (database) => {
    database
      .prepare(
        `DELETE FROM client_consents
          WHERE user_id = (SELECT id FROM users WHERE username = ?)
            AND client_id = ?
            AND realm_id = (SELECT id FROM realms WHERE slug = ?)`
      )
      .run(username, clientId, realm);
  });
}

function setAdminConsent(
  env,
  { username, realm, clientId, scopes = 'openid', grantedVia = 'user', revokedAt = null }
) {
  const now = Date.now();
  const targetUserId = userId(env, username);
  const targetRealmId = realmId(env, realm);
  withSystemDatabase(env, (database) => {
    database
      .prepare(
        `INSERT OR REPLACE INTO client_consents
          (user_id, realm_id, client_id, scopes, granted_via, created_at, updated_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        targetUserId,
        targetRealmId,
        clientId,
        scopes,
        grantedVia,
        now,
        revokedAt || now,
        revokedAt
      );
  });
  return revokedAt || now;
}

function setConsentMode(env, { realm, clientId, mode }) {
  withRealmDatabase(env, realm, (database) => {
    database
      .prepare('UPDATE oidc_clients SET consent_mode = ? WHERE client_id = ?')
      .run(mode, clientId);
  });
}

function userId(env, username) {
  return withSystemDatabase(env, (database) =>
    database.prepare('SELECT id FROM users WHERE username = ?').get(username).id
  );
}

function realmId(env, slug) {
  return withSystemDatabase(env, (database) =>
    database.prepare('SELECT id FROM realms WHERE slug = ?').get(slug).id
  );
}

function clearBans(env, { username, realm, clientId = null }) {
  const id = userId(env, username);
  withRealmDatabase(env, realm, (database) => {
    if (clientId) {
      database
        .prepare('DELETE FROM app_bans WHERE user_id = ? AND client_id = ?')
        .run(id, clientId);
    } else {
      database.prepare('DELETE FROM app_bans WHERE user_id = ?').run(id);
    }
  });
}

function insertRefreshToken(
  env,
  { sessionId, userId: tokenUserId, realmId: tokenRealmId, clientId, scopes = 'openid' }
) {
  const id = crypto.randomUUID();
  const now = Date.now();
  withSystemDatabase(env, (database) => {
    database
      .prepare(
        `INSERT INTO refresh_tokens
          (id, family_id, session_id, user_id, realm_id, client_id, scopes,
           created_at, expires_at, consumed_at, replaced_by, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
      )
      .run(
        id,
        crypto.randomUUID(),
        sessionId,
        tokenUserId,
        tokenRealmId,
        clientId,
        scopes,
        now,
        now + 60_000
      );
  });
  return id;
}

function withRealmDatabase(env, slug, fn) {
  const system = new DatabaseSync(env.AUTH_DATABASE_PATH);
  try {
    const realm = system
      .prepare('SELECT db_file FROM realms WHERE slug = ?')
      .get(slug);
    const database = new DatabaseSync(path.join(env.AUTH_REALMS_PATH, realm.db_file));
    try {
      return fn(database);
    } finally {
      database.close();
    }
  } finally {
    system.close();
  }
}

function insertTestUser(
  env,
  { username, email = null, displayName = username, status = 'active', isSystemAdmin = false }
) {
  const id = crypto.randomUUID();
  const now = Date.now();
  withSystemDatabase(env, (database) => {
    database
      .prepare(
        `INSERT INTO users
          (id, username, username_normalized, display_name, status, home_realm_id,
           is_system_admin, profile, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, '{}', ?, ?)`
      )
      .run(
        id,
        username,
        username.toLowerCase(),
        displayName,
        status,
        isSystemAdmin ? 1 : 0,
        now,
        now
      );
    if (email) {
      database
        .prepare(
          `INSERT INTO user_emails
            (id, user_id, email, email_normalized, verified, is_primary, created_at, verified_at)
           VALUES (?, ?, ?, ?, 1, 1, ?, ?)`
        )
        .run(crypto.randomUUID(), id, email, email.toLowerCase(), now, now);
    }
  });
  return id;
}

function clearRealmMembership(env, realmSlug, membershipUserId) {
  withRealmDatabase(env, realmSlug, (database) => {
    database.prepare('DELETE FROM membership_roles WHERE user_id = ?').run(membershipUserId);
    database.prepare('DELETE FROM realm_memberships WHERE user_id = ?').run(membershipUserId);
  });
}

function clearUserRealmSessions(env, membershipUserId) {
  withSystemDatabase(env, (database) => {
    const sessions = database.prepare('SELECT id FROM sessions WHERE user_id = ?').all(membershipUserId);
    for (const session of sessions) {
      database.prepare('DELETE FROM session_realms WHERE session_id = ?').run(session.id);
      database.prepare('DELETE FROM refresh_tokens WHERE session_id = ?').run(session.id);
    }
    database.prepare('DELETE FROM sessions WHERE user_id = ?').run(membershipUserId);
    database
      .prepare(
        `DELETE FROM session_groups
          WHERE id NOT IN (SELECT group_id FROM sessions)`
      )
      .run();
  });
}

function setTestMembershipStatus(env, realmSlug, membershipUserId, status) {
  const now = Date.now();
  withRealmDatabase(env, realmSlug, (database) => {
    const existing = database
      .prepare('SELECT user_id FROM realm_memberships WHERE user_id = ?')
      .get(membershipUserId);
    if (existing) {
      database
        .prepare('UPDATE realm_memberships SET status = ?, updated_at = ? WHERE user_id = ?')
        .run(status, now, membershipUserId);
      return;
    }
    database
      .prepare('INSERT INTO realm_memberships (user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(membershipUserId, status, now, now);
  });
}

test('HTTP realm, login, OIDC and logout flows', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-http-'));
  const port = await freePort();
  const publicUrl = `http://identity.test:${port}`;
  const env = {
    AUTH_DATABASE_PATH: path.join(dir, 'system.sqlite'),
    AUTH_REALMS_PATH: path.join(dir, 'realms'),
    AUTH_PORT: String(port),
    AUTH_PUBLIC_URL: publicUrl,
    AUTH_ADMIN_APP_URL: `http://admin.test:${port}`,
    AUTH_ACCOUNT_APP_URL: `http://account.test:${port}`,
  };

  const origin = (host) => `http://${host}:${port}`;
  let server = null;

  try {
    await runNode('scripts/seed-demo.js', env);
    server = await startServer(env);

    const identity = (options = {}) =>
      request(port, { host: `identity.test:${port}`, ...options });
    const acme = (options = {}) => request(port, { host: `acme.localhost:${port}`, ...options });
    const globex = (options = {}) => request(port, { host: `globex.localhost:${port}`, ...options });
    const app = (options = {}) => request(port, { host: `app.acme.localhost:${port}`, ...options });

    async function completeAuthorization(requester, { path, cookie, clientId }) {
      let response = await requester({ path, cookie });
      let jar = cookie || '';

      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (response.status !== 302) break;
        const location = locationQuery(response);
        if (!location.pathname.endsWith('/consent')) break;

        jar = mergeCookies(jar, response);
        const consent = await requester({
          path: `/api/v1/consent?client_id=${encodeURIComponent(clientId)}`,
          cookie: jar,
        });
        assert.equal(consent.status, 200);
        assert.deepEqual(consent.json.client.id, clientId);

        const allow = await requester({
          method: 'POST',
          path: '/api/v1/consent',
          body: { client_id: clientId, decision: 'allow' },
          cookie: jar,
        });
        assert.equal(allow.status, 200);
        response = await requester({ path: path.split('?')[0], cookie: jar });
      }

      return { response, cookie: jar };
    }

    async function accessToken(
      requester,
      { clientId, identifier, redirectUri, scope = 'openid profile' }
    ) {
      const { verifier, challenge } = pkce();
      const authorizePath =
        `/oidc/${clientId}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}` +
        `&state=admin-api&code_challenge=${challenge}&code_challenge_method=S256`;

      const first = await requester({ path: authorizePath });
      assert.equal(first.status, 302);
      let jar = mergeCookies('', first);
      const login = await requester({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: clientId, identifier, password: 'demo' },
        cookie: jar,
      });
      assert.equal(login.status, 200);
      jar = mergeCookies(jar, login);

      const completed = await completeAuthorization(requester, {
        path: authorizePath.split('?')[0],
        cookie: jar,
        clientId,
      });
      assert.equal(completed.response.status, 302);
      const code = locationQuery(completed.response).searchParams.get('code');
      assert.ok(code);

      const tokenResponse = await requester({
        method: 'POST',
        path: `/oidc/${clientId}/token`,
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
        },
      });
      assert.equal(tokenResponse.status, 200);
      return {
        access_token: tokenResponse.json.access_token,
        refresh_token: tokenResponse.json.refresh_token,
        cookie: completed.cookie,
      };
    }

    async function adminToken(identifier = 'admin@system.test') {
      return accessToken(identity, {
        clientId: 'admin',
        identifier,
        redirectUri: `${origin('identity.test')}/app/admin/callback`,
      });
    }

    const adminRequest = (admin, options) =>
      identity({ bearer: admin.access_token, ...options });

    async function createAdminClient(admin, realm, body) {
      return adminRequest(admin, {
        method: 'POST',
        path: `/api/v1/admin/realms/${realm}/clients`,
        body,
      });
    }

    async function updateAdminClient(admin, realm, clientId, body) {
      return adminRequest(admin, {
        method: 'PATCH',
        path: `/api/v1/admin/realms/${realm}/clients/${encodeURIComponent(clientId)}`,
        body,
      });
    }

    async function deleteAdminClient(admin, realm, clientId) {
      return adminRequest(admin, {
        method: 'DELETE',
        path: `/api/v1/admin/realms/${realm}/clients/${encodeURIComponent(clientId)}`,
      });
    }

    async function authorizeCodeForClient(
      requester,
      { clientId, identifier, redirectUri, scope = 'openid profile', state }
    ) {
      const { verifier, challenge } = pkce();
      const authorizePath =
        `/oidc/${clientId}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}` +
        `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;
      const first = await requester({ path: authorizePath });
      let jar = mergeCookies('', first);
      const login = await requester({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: clientId, identifier, password: 'demo' },
        cookie: jar,
      });
      jar = mergeCookies(jar, login);
      const completed = await completeAuthorization(requester, {
        path: authorizePath.split('?')[0],
        cookie: jar,
        clientId,
      });
      const code = locationQuery(completed.response).searchParams.get('code');
      assert.ok(code);
      return { verifier, code };
    }

    await t.test('realm metadata is served for a realm hostname', async () => {
      const response = await acme({ path: '/api/v1/realm' });
      assert.equal(response.status, 200);
      assert.equal(response.json.slug, 'acme');
      assert.equal(response.json.allow_session_duration_choice, true);
    });

    await t.test('hostname wins over a conflicting path slug', async () => {
      const response = await acme({ path: '/api/v1/realm?realm=globex' });
      assert.equal(response.status, 404);
      assert.equal(response.json.error.code, 'unknown_realm');
    });

    await t.test('client discovery works on identity, realm and client hosts', async () => {
      const canonical = await identity({
        path: '/oidc/internal-app/openid-configuration',
      });
      assert.equal(canonical.status, 200);
      assert.equal(canonical.json.client_id, 'internal-app');
      assert.equal(canonical.json.issuer, `${publicUrl}/oidc/acme`);
      assert.equal(
        canonical.json.authorization_endpoint,
        `${origin('identity.test')}/oidc/internal-app/authorize`
      );

      const realmHost = await acme({ path: '/oidc/internal-app/openid-configuration' });
      assert.equal(realmHost.status, 200);
      assert.equal(
        realmHost.json.token_endpoint,
        `${origin('acme.localhost')}/oidc/internal-app/token`
      );

      const clientHost = await app({ path: '/oidc/openid-configuration' });
      assert.equal(clientHost.status, 200);
      assert.equal(clientHost.json.client_id, 'internal-app');
      assert.equal(clientHost.json.token_endpoint, `${origin('app.acme.localhost')}/oidc/token`);
    });

    await t.test('realm slugs are not accepted in OIDC paths', async () => {
      const oldCanonical = await identity({
        path: '/oidc/acme/internal-app/openid-configuration',
      });
      assert.equal(oldCanonical.status, 404);

      const oldRealmHost = await acme({
        path: '/oidc/acme/internal-app/openid-configuration',
      });
      assert.equal(oldRealmHost.status, 404);
    });

    await t.test('client-to-realm mappings enforce host and canonical routing', async () => {
      const mismatch = await globex({ path: '/oidc/internal-app/openid-configuration' });
      assert.equal(mismatch.status, 404);
      assert.equal(mismatch.json.error.code, 'unknown_client');

      const unknownCanonicalHost = await request(port, {
        host: `unknown.test:${port}`,
        path: '/oidc/internal-app/openid-configuration',
      });
      assert.equal(unknownCanonicalHost.status, 404);

      const otherRealm = await identity({
        path: '/oidc/globex-members-app/openid-configuration',
      });
      assert.equal(otherRealm.status, 200);
      assert.equal(otherRealm.json.issuer, `${publicUrl}/oidc/globex`);
    });

    await t.test('system clients are discoverable on their allowed hosts', async () => {
      const admin = await identity({ path: '/oidc/admin/openid-configuration' });
      assert.equal(admin.status, 200);
      assert.equal(admin.json.system_client, true);
      assert.equal(admin.json.access_mode, 'admin');
      assert.equal(admin.json.issuer, publicUrl);

      const adminRealm = await acme({ path: '/oidc/admin/openid-configuration' });
      assert.equal(adminRealm.status, 404);

      const account = await identity({ path: '/oidc/account/openid-configuration' });
      assert.equal(account.status, 200);
      assert.equal(account.json.system_client, true);
      assert.equal(account.json.access_mode, 'public');

      const accountRealm = await acme({ path: '/oidc/account/openid-configuration' });
      assert.equal(accountRealm.status, 200);
      assert.equal(accountRealm.json.system_client, true);
    });

    await t.test('identifier resolution selects password or upstream OIDC', async () => {
      const password = await acme({
        method: 'POST',
        path: '/api/v1/login/resolve',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test' },
      });
      assert.equal(password.status, 200);
      assert.equal(password.json.next, 'password');

      const upstream = await acme({
        method: 'POST',
        path: '/api/v1/login/resolve',
        body: { client_id: 'internal-app', identifier: 'someone@sso.acme.test' },
      });
      assert.equal(upstream.status, 200);
      assert.equal(upstream.json.next, 'oidc');
      assert.equal(upstream.json.provider.display_name, 'Example SSO');
    });

    await t.test('password login creates a realm session with the short cookie', async () => {
      const response = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      assert.equal(response.status, 200);
      assert.equal(response.json.user.username, 'alice');
      assert.equal(maxAge(response), 12 * 60 * 60);
      assert.ok(responseCookies(response)[0].startsWith('auth_session='));

      const cookie = mergeCookies('', response);
      const session = await acme({ path: '/api/v1/session', cookie });
      assert.equal(session.status, 200);
      assert.equal(session.json.user.username, 'alice');
      assert.equal(session.json.scope.type, 'realm');
      assert.equal(session.json.scope.host, 'acme.localhost');
      assert.equal(session.json.realm.slug, 'acme');
    });

    await t.test('canonical and client hosts create their own session scopes', async () => {
      const canonical = await identity({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      assert.equal(canonical.status, 200);
      const canonicalCookie = mergeCookies('', canonical);
      const canonicalSession = await identity({
        path: '/api/v1/session',
        cookie: canonicalCookie,
      });
      assert.equal(canonicalSession.status, 200);
      assert.equal(canonicalSession.json.scope.type, 'global');
      assert.equal(canonicalSession.json.scope.host, 'identity.test');
      assert.equal(canonicalSession.json.realm, null);

      const client = await app({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      assert.equal(client.status, 200);
      const clientSession = await app({
        path: '/api/v1/session',
        cookie: mergeCookies('', client),
      });
      assert.equal(clientSession.status, 200);
      assert.equal(clientSession.json.scope.type, 'client');
      assert.equal(clientSession.json.scope.host, 'app.acme.localhost');
      assert.equal(clientSession.json.scope.client_id, 'internal-app');
      assert.equal(clientSession.json.realm.slug, 'acme');
    });

    await t.test('sessions are scoped to their host and old cookies are rejected', async () => {
      const login = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      const cookie = mergeCookies('', login);
      const token = cookie.slice('auth_session='.length);

      const wrongHost = await globex({ path: '/api/v1/session', cookie });
      assert.equal(wrongHost.status, 401);

      const oldCookie = `auth_session_acme=${token}`;
      const oldStyle = await acme({ path: '/api/v1/session', cookie: oldCookie });
      assert.equal(oldStyle.status, 401);
    });

    await t.test('a host group holds multiple accounts and can switch', async () => {
      const aliceLogin = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      assert.equal(aliceLogin.status, 200);
      const aliceCookie = mergeCookies('', aliceLogin);

      const itLogin = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'it@acme.test', password: 'demo' },
        cookie: aliceCookie,
      });
      assert.equal(itLogin.status, 200);
      assert.equal(responseCookies(itLogin)[0], responseCookies(aliceLogin)[0]);
      const cookie = mergeCookies(aliceCookie, itLogin);

      const session = await acme({ path: '/api/v1/session', cookie });
      assert.equal(session.status, 200);
      assert.equal(session.json.user.username, 'acme-it');
      assert.deepEqual(
        session.json.accounts.map((account) => account.user.username),
        ['alice', 'acme-it']
      );
      assert.equal(
        session.json.accounts.find((account) => account.user.username === 'acme-it').active,
        true
      );

      const aliceAccount = session.json.accounts.find(
        (account) => account.user.username === 'alice'
      );
      const selected = await acme({
        method: 'POST',
        path: '/api/v1/session/select',
        body: { public_id: aliceAccount.public_id, client_id: 'internal-app' },
        cookie,
      });
      assert.equal(selected.status, 200);
      assert.equal(selected.json.user.username, 'alice');
      assert.equal(selected.json.pending_auth_request, false);

      const switched = await acme({ path: '/api/v1/session', cookie });
      assert.equal(switched.status, 200);
      assert.equal(switched.json.user.username, 'alice');
    });

    await t.test('authorize asks which account to use when the group has multiple accounts', async () => {
      const aliceLogin = await app({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      let jar = mergeCookies('', aliceLogin);
      const itLogin = await app({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'it@acme.test', password: 'demo' },
        cookie: jar,
      });
      jar = mergeCookies(jar, itLogin);

      const { verifier, challenge } = pkce();
      const redirectUri = `${origin('app.acme.localhost')}/callback`;
      const authorizePath =
        `/oidc/authorize?response_type=code&client_id=internal-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email` +
        `&state=state-select&code_challenge=${challenge}&code_challenge_method=S256`;

      const first = await app({ path: authorizePath, cookie: jar });
      assert.equal(first.status, 302);
      assert.equal(locationQuery(first).pathname, '/oidc/login');
      jar = mergeCookies(jar, first);

      const session = await app({ path: '/api/v1/session', cookie: jar });
      const aliceAccount = session.json.accounts.find(
        (account) => account.user.username === 'alice'
      );
      const selected = await app({
        method: 'POST',
        path: '/api/v1/session/select',
        body: { public_id: aliceAccount.public_id, client_id: 'internal-app' },
        cookie: jar,
      });
      assert.equal(selected.status, 200);
      assert.equal(selected.json.pending_auth_request, true);
      assert.equal(selected.json.user.username, 'alice');

      const completed = await completeAuthorization(app, {
        path: authorizePath,
        cookie: jar,
        clientId: 'internal-app',
      });
      assert.equal(completed.response.status, 302);
      const redirected = locationQuery(completed.response);
      assert.equal(redirected.searchParams.get('state'), 'state-select');
      const code = redirected.searchParams.get('code');
      assert.ok(code);

      const tokenResponse = await app({
        method: 'POST',
        path: '/oidc/token',
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: 'internal-app',
          code_verifier: verifier,
        },
      });
      assert.equal(tokenResponse.status, 200);

      const jwks = await app({ path: '/oidc/jwks' });
      const keySet = createLocalJWKSet(jwks.json);
      const { payload } = await jwtVerify(tokenResponse.json.id_token, keySet, {
        issuer: `${publicUrl}/oidc/acme`,
        audience: 'internal-app',
      });
      assert.equal(payload.preferred_username, 'alice');
    });

    await t.test('a revoked realm binding requires password re-verification', async () => {
      const login = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      assert.equal(login.status, 200);
      let jar = mergeCookies('', login);

      const { verifier, challenge } = pkce();
      const redirectUri = `${origin('app.acme.localhost')}/callback`;
      const authorizePath =
        `/oidc/internal-app/authorize?response_type=code&client_id=internal-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email` +
        `&state=state-revoked&code_challenge=${challenge}&code_challenge_method=S256`;

      const completed = await completeAuthorization(acme, {
        path: authorizePath,
        cookie: jar,
        clientId: 'internal-app',
      });
      assert.equal(completed.response.status, 302);
      assert.ok(locationQuery(completed.response).searchParams.get('code'));

      const sessionId = activeSessionId(env, jar);
      const revokedAt = Date.now();
      withSystemDatabase(env, (database) => {
        database
          .prepare(
            `UPDATE session_realms
                SET revoked_at = ?, revoked_by = ?
              WHERE session_id = ?
                AND realm_id = (SELECT id FROM realms WHERE slug = 'acme')`
          )
          .run(revokedAt, 'test-admin', sessionId);
      });

      const reauth = await acme({ path: authorizePath, cookie: jar });
      assert.equal(reauth.status, 302);
      const reauthLocation = locationQuery(reauth);
      assert.equal(reauthLocation.pathname, '/oidc/internal-app/login');
      assert.equal(reauthLocation.searchParams.get('reauth'), '1');
      jar = mergeCookies(jar, reauth);

      const relogin = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
        cookie: jar,
      });
      assert.equal(relogin.status, 200);
      assert.equal(relogin.json.pending_auth_request, true);
      jar = mergeCookies(jar, relogin);

      const second = await completeAuthorization(acme, {
        path: authorizePath,
        cookie: jar,
        clientId: 'internal-app',
      });
      assert.equal(second.response.status, 302);
      const code = locationQuery(second.response).searchParams.get('code');
      assert.ok(code);

      const binding = withSystemDatabase(env, (database) =>
        database
          .prepare(
            `SELECT revoked_at
               FROM session_realms
              WHERE session_id = ?
                AND realm_id = (SELECT id FROM realms WHERE slug = 'acme')`
          )
          .get(sessionId)
      );
      assert.equal(binding.revoked_at, null);

      const tokenResponse = await acme({
        method: 'POST',
        path: '/oidc/internal-app/token',
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: 'internal-app',
          code_verifier: verifier,
        },
      });
      assert.equal(tokenResponse.status, 200);
    });

    await t.test('the account chooser cannot bypass a revoked realm binding', async () => {
      const aliceLogin = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      let jar = mergeCookies('', aliceLogin);
      const itLogin = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'it@acme.test', password: 'demo' },
        cookie: jar,
      });
      jar = mergeCookies(jar, itLogin);

      const { challenge } = pkce();
      const redirectUri = `${origin('app.acme.localhost')}/callback`;
      const authorizePath =
        `/oidc/internal-app/authorize?response_type=code&client_id=internal-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email` +
        `&state=state-revoked-chooser&code_challenge=${challenge}&code_challenge_method=S256`;

      const chooser = await acme({ path: authorizePath, cookie: jar });
      assert.equal(chooser.status, 302);
      assert.equal(locationQuery(chooser).pathname, '/oidc/internal-app/login');
      jar = mergeCookies(jar, chooser);

      const session = await acme({ path: '/api/v1/session', cookie: jar });
      const itAccount = session.json.accounts.find(
        (account) => account.user.username === 'acme-it'
      );
      const selected = await acme({
        method: 'POST',
        path: '/api/v1/session/select',
        body: { public_id: itAccount.public_id, client_id: 'internal-app' },
        cookie: jar,
      });
      assert.equal(selected.status, 200);
      assert.equal(selected.json.pending_auth_request, true);

      const authorized = await completeAuthorization(acme, {
        path: authorizePath,
        cookie: jar,
        clientId: 'internal-app',
      });
      assert.equal(authorized.response.status, 302);
      assert.ok(locationQuery(authorized.response).searchParams.get('code'));

      const sessionId = activeSessionId(env, jar);
      withSystemDatabase(env, (database) => {
        database
          .prepare(
            `UPDATE session_realms
                SET revoked_at = ?, revoked_by = ?
              WHERE session_id = ?
                AND realm_id = (SELECT id FROM realms WHERE slug = 'acme')`
          )
          .run(Date.now(), 'test-admin', sessionId);
      });

      const nextChooser = await acme({ path: authorizePath, cookie: jar });
      assert.equal(nextChooser.status, 302);
      const chooserLocation = locationQuery(nextChooser);
      assert.equal(chooserLocation.pathname, '/oidc/internal-app/login');
      assert.equal(chooserLocation.searchParams.get('reauth'), null);
      jar = mergeCookies(jar, nextChooser);

      const reselected = await acme({
        method: 'POST',
        path: '/api/v1/session/select',
        body: { public_id: itAccount.public_id, client_id: 'internal-app' },
        cookie: jar,
      });
      assert.equal(reselected.status, 200);
      assert.equal(reselected.json.pending_auth_request, true);

      const blocked = await acme({ path: authorizePath, cookie: jar });
      assert.equal(blocked.status, 302);
      const blockedLocation = locationQuery(blocked);
      assert.equal(blockedLocation.pathname, '/oidc/internal-app/login');
      assert.equal(blockedLocation.searchParams.get('reauth'), '1');
    });

    await t.test('unknown hosts are rejected by auth and session APIs', async () => {
      const unknown = (options = {}) =>
        request(port, { host: `unknown.test:${port}`, ...options });

      const login = await unknown({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      assert.equal(login.status, 404);

      const session = await unknown({ path: '/api/v1/session' });
      assert.equal(session.status, 404);
    });

    await t.test('long sessions are only issued when requested', async () => {
      const response = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: {
          client_id: 'internal-app',
          identifier: 'alice@acme.test',
          password: 'demo',
          long_session: true,
        },
      });
      assert.equal(response.status, 200);
      assert.equal(maxAge(response), 7 * 24 * 60 * 60);
    });

    await t.test('bad credentials are generic', async () => {
      const response = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'wrong' },
      });
      assert.equal(response.status, 401);
      assert.equal(response.json.error.code, 'invalid_credentials');
    });

    await t.test('membership is required where the client demands it', async () => {
      const denied = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: {
          client_id: 'acme-members-app',
          identifier: 'contractor@personal.test',
          password: 'demo',
        },
      });
      assert.equal(denied.status, 401);

      const allowed = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: {
          client_id: 'acme-public-app',
          identifier: 'guest@personal.test',
          password: 'demo',
        },
      });
      assert.equal(allowed.status, 200);
    });

    await t.test('password login is rejected for upstream-mapped domains', async () => {
      const response = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'someone@sso.acme.test', password: 'demo' },
      });
      assert.equal(response.status, 403);
      assert.equal(response.json.error.code, 'provider_required');
    });

    await t.test('guests can hold realm-admin roles', async () => {
      const response = await globex({
        method: 'POST',
        path: '/api/v1/login/password',
        body: {
          client_id: 'globex-members-app',
          identifier: 'contractor@personal.test',
          password: 'demo',
        },
      });
      assert.equal(response.status, 200);
      const session = await globex({
        path: '/api/v1/session',
        cookie: mergeCookies('', response),
      });
      assert.equal(session.status, 200);
      assert.ok(session.json.roles.includes('realm-admin'));
    });

    await t.test('authorization code flow issues verifiable tokens', async () => {
      const { verifier, challenge } = pkce();
      const redirectUri = `${origin('app.acme.localhost')}/callback`;
      const authorizePath =
        `/oidc/authorize?response_type=code&client_id=internal-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20profile%20email` +
        `&state=state-1&nonce=nonce-1&code_challenge=${challenge}&code_challenge_method=S256`;

      const first = await app({ path: authorizePath });
      assert.equal(first.status, 302);
      assert.equal(locationQuery(first).pathname, '/oidc/login');
      let jar = mergeCookies('', first);

      const login = await app({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
        cookie: jar,
      });
      assert.equal(login.status, 200);
      assert.equal(login.json.pending_auth_request, true);
      jar = mergeCookies(jar, login);

      const second = await completeAuthorization(app, {
        path: authorizePath,
        cookie: jar,
        clientId: 'internal-app',
      });
      assert.equal(second.response.status, 302);
      const redirected = locationQuery(second.response);
      assert.equal(redirected.origin + redirected.pathname, redirectUri);
      assert.equal(redirected.searchParams.get('state'), 'state-1');
      const code = redirected.searchParams.get('code');
      assert.ok(code);

      const tokenResponse = await app({
        method: 'POST',
        path: '/oidc/token',
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: 'internal-app',
          code_verifier: verifier,
        },
      });
      assert.equal(tokenResponse.status, 200);
      assert.ok(tokenResponse.json.id_token);
      assert.ok(tokenResponse.json.access_token);

      const jwks = await app({ path: '/oidc/jwks' });
      const keySet = createLocalJWKSet(jwks.json);
      const { payload } = await jwtVerify(tokenResponse.json.id_token, keySet, {
        issuer: `${publicUrl}/oidc/acme`,
        audience: 'internal-app',
      });
      assert.equal(payload.preferred_username, 'alice');
      assert.equal(payload.email, 'alice@acme.test');
      assert.equal(payload.nonce, 'nonce-1');

      const userinfo = await app({
        path: '/oidc/userinfo',
        bearer: tokenResponse.json.access_token,
      });
      assert.equal(userinfo.status, 200);
      assert.equal(userinfo.json.preferred_username, 'alice');

      const reuse = await app({
        method: 'POST',
        path: '/oidc/token',
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: 'internal-app',
          code_verifier: verifier,
        },
      });
      assert.equal(reuse.status, 400);
      assert.equal(reuse.json.error, 'invalid_grant');
    });

    await t.test('canonical realm-client flow resolves the realm from its mapping', async () => {
      const { verifier, challenge } = pkce();
      const redirectUri = `${origin('app.acme.localhost')}/callback`;
      const authorizePath =
        `/oidc/internal-app/authorize?response_type=code&client_id=internal-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email` +
        `&state=state-canonical&code_challenge=${challenge}&code_challenge_method=S256`;

      const first = await identity({ path: authorizePath });
      assert.equal(first.status, 302);
      assert.equal(locationQuery(first).pathname, '/oidc/internal-app/login');
      let jar = mergeCookies('', first);

      const login = await identity({
        method: 'POST',
        path: '/api/v1/login/password',
        body: {
          client_id: 'internal-app',
          identifier: 'alice@acme.test',
          password: 'demo',
        },
        cookie: jar,
      });
      assert.equal(login.status, 200);
      assert.equal(login.json.pending_auth_request, true);
      jar = mergeCookies(jar, login);

      const second = await completeAuthorization(identity, {
        path: authorizePath,
        cookie: jar,
        clientId: 'internal-app',
      });
      assert.equal(second.response.status, 302);
      const redirected = locationQuery(second.response);
      assert.equal(redirected.searchParams.get('state'), 'state-canonical');
      const code = redirected.searchParams.get('code');
      assert.ok(code);

      const tokenResponse = await identity({
        method: 'POST',
        path: '/oidc/internal-app/token',
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: 'internal-app',
          code_verifier: verifier,
        },
      });
      assert.equal(tokenResponse.status, 200);

      const database = new DatabaseSync(env.AUTH_DATABASE_PATH, { readOnly: true });
      try {
        const binding = database
          .prepare(
            `SELECT COUNT(*) AS count
               FROM session_realms sr
               JOIN sessions s ON s.id = sr.session_id
               JOIN realms r ON r.id = sr.realm_id
              WHERE r.slug = 'acme' AND s.scope_type = 'global'`
          )
          .get();
        assert.equal(binding.count, 1);
      } finally {
        database.close();
      }
    });

    await t.test('public clients allow non-members through authorize', async () => {
      const { verifier, challenge } = pkce();
      const redirectUri = `${origin('public.localhost')}/callback`;
      const authorizePath =
        `/oidc/acme-public-app/authorize?response_type=code&client_id=acme-public-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email` +
        `&state=state-2&code_challenge=${challenge}&code_challenge_method=S256`;

      const first = await acme({ path: authorizePath });
      assert.equal(first.status, 302);
      let jar = mergeCookies('', first);

      const login = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: {
          client_id: 'acme-public-app',
          identifier: 'contractor@personal.test',
          password: 'demo',
        },
        cookie: jar,
      });
      assert.equal(login.status, 200);
      assert.equal(login.json.pending_auth_request, true);
      jar = mergeCookies(jar, login);

      const second = await completeAuthorization(acme, {
        path: authorizePath,
        cookie: jar,
        clientId: 'acme-public-app',
      });
      assert.equal(second.response.status, 302);
      const code = locationQuery(second.response).searchParams.get('code');
      assert.ok(code);

      const tokenResponse = await acme({
        method: 'POST',
        path: '/oidc/acme-public-app/token',
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: 'acme-public-app',
          code_verifier: verifier,
        },
      });
      assert.equal(tokenResponse.status, 200);
    });

    await t.test('remembered consent prompts once and can be denied', async () => {
      clearConsent(env, { username: 'alice', realm: 'acme', clientId: 'internal-app' });

      const login = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      let jar = mergeCookies('', login);

      const { verifier, challenge } = pkce();
      const redirectUri = `${origin('app.acme.localhost')}/callback`;
      const authorizePath =
        `/oidc/internal-app/authorize?response_type=code&client_id=internal-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email` +
        `&state=consent-once&code_challenge=${challenge}&code_challenge_method=S256`;

      const prompt = await acme({ path: authorizePath, cookie: jar });
      assert.equal(prompt.status, 302);
      assert.equal(locationQuery(prompt).pathname, '/oidc/internal-app/consent');
      jar = mergeCookies(jar, prompt);

      const request = await acme({
        path: '/api/v1/consent?client_id=internal-app',
        cookie: jar,
      });
      assert.equal(request.status, 200);
      assert.equal(request.json.client.id, 'internal-app');
      assert.equal(request.json.user.username, 'alice');
      assert.ok(request.json.scopes.includes('email'));

      const allow = await acme({
        method: 'POST',
        path: '/api/v1/consent',
        body: { client_id: 'internal-app', decision: 'allow' },
        cookie: jar,
      });
      assert.equal(allow.status, 200);
      assert.equal(new URL(allow.json.redirect).pathname, '/oidc/internal-app/authorize');

      const approved = await acme({ path: authorizePath.split('?')[0], cookie: jar });
      assert.equal(approved.status, 302);
      assert.ok(locationQuery(approved).searchParams.get('code'));

      const stored = withSystemDatabase(env, (database) =>
        database
          .prepare(
            `SELECT scopes, granted_via, revoked_at
               FROM client_consents
              WHERE user_id = (SELECT id FROM users WHERE username = 'alice')
                AND client_id = 'internal-app'
                AND realm_id = (SELECT id FROM realms WHERE slug = 'acme')`
          )
          .get()
      );
      assert.equal(stored.granted_via, 'user');
      assert.equal(stored.revoked_at, null);
      assert.ok(stored.scopes.includes('email'));

      const repeat = pkce();
      const repeatPath =
        `/oidc/internal-app/authorize?response_type=code&client_id=internal-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email` +
        `&state=consent-repeat&code_challenge=${repeat.challenge}&code_challenge_method=S256`;
      const direct = await acme({ path: repeatPath, cookie: jar });
      assert.equal(direct.status, 302);
      assert.ok(locationQuery(direct).searchParams.get('code'));

      clearConsent(env, { username: 'alice', realm: 'acme', clientId: 'internal-app' });
      const denied = pkce();
      const denyPath =
        `/oidc/internal-app/authorize?response_type=code&client_id=internal-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email` +
        `&state=consent-deny&code_challenge=${denied.challenge}&code_challenge_method=S256`;
      const denyPrompt = await acme({ path: denyPath, cookie: jar });
      assert.equal(locationQuery(denyPrompt).pathname, '/oidc/internal-app/consent');
      jar = mergeCookies(jar, denyPrompt);

      const deny = await acme({
        method: 'POST',
        path: '/api/v1/consent',
        body: { client_id: 'internal-app', decision: 'deny' },
        cookie: jar,
      });
      assert.equal(deny.status, 200);
      const deniedRedirect = new URL(deny.json.redirect);
      assert.equal(deniedRedirect.searchParams.get('error'), 'access_denied');
      assert.equal(deniedRedirect.searchParams.get('state'), 'consent-deny');

      const missing = await acme({
        path: '/api/v1/consent?client_id=internal-app',
        cookie: jar,
      });
      assert.equal(missing.status, 400);
    });

    await t.test('consent scope upgrades require a new prompt', async () => {
      clearConsent(env, { username: 'alice', realm: 'acme', clientId: 'internal-app' });

      const login = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      let jar = mergeCookies('', login);
      const redirectUri = `${origin('app.acme.localhost')}/callback`;

      const base = pkce();
      const basePath =
        `/oidc/internal-app/authorize?response_type=code&client_id=internal-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20profile` +
        `&state=scope-base&code_challenge=${base.challenge}&code_challenge_method=S256`;
      const approved = await completeAuthorization(acme, {
        path: basePath,
        cookie: jar,
        clientId: 'internal-app',
      });
      jar = approved.cookie;
      assert.ok(locationQuery(approved.response).searchParams.get('code'));

      const upgrade = pkce();
      const upgradePath =
        `/oidc/internal-app/authorize?response_type=code&client_id=internal-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20profile%20email` +
        `&state=scope-upgrade&code_challenge=${upgrade.challenge}&code_challenge_method=S256`;
      const prompt = await acme({ path: upgradePath, cookie: jar });
      assert.equal(prompt.status, 302);
      assert.equal(locationQuery(prompt).pathname, '/oidc/internal-app/consent');
    });

    await t.test('trusted clients skip consent for home users but guests still prompt', async () => {
      setConsentMode(env, { realm: 'acme', clientId: 'acme-members-app', mode: 'trusted' });
      clearConsent(env, { username: 'alice', realm: 'acme', clientId: 'acme-members-app' });
      try {
        const login = await acme({
          method: 'POST',
          path: '/api/v1/login/password',
          body: {
            client_id: 'acme-members-app',
            identifier: 'alice@acme.test',
            password: 'demo',
          },
        });
        const jar = mergeCookies('', login);
        const home = pkce();
        const homePath =
          `/oidc/acme-members-app/authorize?response_type=code&client_id=acme-members-app` +
          `&redirect_uri=${encodeURIComponent(`${origin('members.localhost')}/callback`)}` +
          `&scope=openid%20email&state=trusted-home` +
          `&code_challenge=${home.challenge}&code_challenge_method=S256`;
        const direct = await acme({ path: homePath, cookie: jar });
        assert.equal(direct.status, 302);
        assert.ok(locationQuery(direct).searchParams.get('code'));

        const stored = withSystemDatabase(env, (database) =>
          database
            .prepare(
              `SELECT granted_via
                 FROM client_consents
                WHERE user_id = (SELECT id FROM users WHERE username = 'alice')
                  AND client_id = 'acme-members-app'
                  AND realm_id = (SELECT id FROM realms WHERE slug = 'acme')`
            )
            .get()
        );
        assert.equal(stored.granted_via, 'trusted');

        setConsentMode(env, {
          realm: 'acme',
          clientId: 'acme-members-app',
          mode: 'remembered',
        });
        const changed = pkce();
        const changedPath =
          `/oidc/acme-members-app/authorize?response_type=code&client_id=acme-members-app` +
          `&redirect_uri=${encodeURIComponent(`${origin('members.localhost')}/callback`)}` +
          `&scope=openid%20email&state=trusted-changed` +
          `&code_challenge=${changed.challenge}&code_challenge_method=S256`;
        const prompt = await acme({ path: changedPath, cookie: jar });
        assert.equal(prompt.status, 302);
        assert.equal(locationQuery(prompt).pathname, '/oidc/acme-members-app/consent');
      } finally {
        setConsentMode(env, {
          realm: 'acme',
          clientId: 'acme-members-app',
          mode: 'remembered',
        });
        clearConsent(env, {
          username: 'alice',
          realm: 'acme',
          clientId: 'acme-members-app',
        });
      }

      setConsentMode(env, { realm: 'acme', clientId: 'acme-public-app', mode: 'trusted' });
      clearConsent(env, {
        username: 'contractor',
        realm: 'acme',
        clientId: 'acme-public-app',
      });
      try {
        const guest = pkce();
        const guestPath =
          `/oidc/acme-public-app/authorize?response_type=code&client_id=acme-public-app` +
          `&redirect_uri=${encodeURIComponent(`${origin('public.localhost')}/callback`)}` +
          `&scope=openid%20email&state=trusted-guest` +
          `&code_challenge=${guest.challenge}&code_challenge_method=S256`;
        const first = await acme({ path: guestPath });
        let jar = mergeCookies('', first);
        const login = await acme({
          method: 'POST',
          path: '/api/v1/login/password',
          body: {
            client_id: 'acme-public-app',
            identifier: 'contractor@personal.test',
            password: 'demo',
          },
          cookie: jar,
        });
        assert.equal(login.status, 200);
        assert.equal(login.json.pending_auth_request, true);
        jar = mergeCookies(jar, login);

        const prompt = await acme({ path: guestPath, cookie: jar });
        assert.equal(prompt.status, 302);
        assert.equal(locationQuery(prompt).pathname, '/oidc/acme-public-app/consent');
      } finally {
        setConsentMode(env, {
          realm: 'acme',
          clientId: 'acme-public-app',
          mode: 'remembered',
        });
        clearConsent(env, {
          username: 'contractor',
          realm: 'acme',
          clientId: 'acme-public-app',
        });
      }
    });

    await t.test('client-host account shows and revokes current app consent', async () => {
      clearConsent(env, { username: 'alice', realm: 'acme', clientId: 'internal-app' });

      const login = await app({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      let jar = mergeCookies('', login);
      const redirectUri = `${origin('app.acme.localhost')}/callback`;
      const { challenge } = pkce();
      const authorizePath =
        `/oidc/authorize?response_type=code&client_id=internal-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email` +
        `&state=client-consent&code_challenge=${challenge}&code_challenge_method=S256`;

      const prompt = await app({ path: authorizePath, cookie: jar });
      assert.equal(prompt.status, 302);
      assert.equal(locationQuery(prompt).pathname, '/oidc/consent');
      jar = mergeCookies(jar, prompt);

      const allow = await app({
        method: 'POST',
        path: '/api/v1/consent',
        body: { client_id: 'internal-app', decision: 'allow' },
        cookie: jar,
      });
      assert.equal(allow.status, 200);
      const approved = await app({ path: authorizePath.split('?')[0], cookie: jar });
      assert.ok(locationQuery(approved).searchParams.get('code'));

      const current = await app({
        path: '/api/v1/account/clients/internal-app/consent',
        cookie: jar,
      });
      assert.equal(current.status, 200);
      assert.equal(current.json.active, true);
      assert.equal(current.json.client.id, 'internal-app');
      assert.equal(current.json.account_url, `${publicUrl}/app/account`);

      const wrongClient = await app({
        path: '/api/v1/account/clients/acme-members-app/consent',
        cookie: jar,
      });
      assert.equal(wrongClient.status, 404);

      const revoked = await app({
        method: 'DELETE',
        path: '/api/v1/account/clients/internal-app/consent',
        cookie: jar,
      });
      assert.equal(revoked.status, 200);
      assert.equal(revoked.json.ok, true);
      assert.equal(revoked.json.active, false);

      const session = await app({ path: '/api/v1/session', cookie: jar });
      assert.equal(session.status, 200);

      const next = pkce();
      const nextPath =
        `/oidc/authorize?response_type=code&client_id=internal-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email` +
        `&state=client-revoked&code_challenge=${next.challenge}&code_challenge_method=S256`;
      const reprompt = await app({ path: nextPath, cookie: jar });
      assert.equal(reprompt.status, 302);
      assert.equal(locationQuery(reprompt).pathname, '/oidc/consent');
    });

    await t.test('revoking consent after authorization blocks the code exchange', async () => {
      clearConsent(env, { username: 'alice', realm: 'acme', clientId: 'internal-app' });

      const login = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      const jar = mergeCookies('', login);
      const { verifier, challenge } = pkce();
      const redirectUri = `${origin('app.acme.localhost')}/callback`;
      const authorizePath =
        `/oidc/internal-app/authorize?response_type=code&client_id=internal-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email` +
        `&state=revoked-code&code_challenge=${challenge}&code_challenge_method=S256`;

      const approved = await completeAuthorization(acme, {
        path: authorizePath,
        cookie: jar,
        clientId: 'internal-app',
      });
      const code = locationQuery(approved.response).searchParams.get('code');
      assert.ok(code);

      withSystemDatabase(env, (database) => {
        database
          .prepare(
            `UPDATE client_consents
                SET revoked_at = ?
              WHERE user_id = (SELECT id FROM users WHERE username = 'alice')
                AND client_id = 'internal-app'
                AND realm_id = (SELECT id FROM realms WHERE slug = 'acme')`
          )
          .run(Date.now());
      });

      const tokenResponse = await acme({
        method: 'POST',
        path: '/oidc/internal-app/token',
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: 'internal-app',
          code_verifier: verifier,
        },
      });
      assert.equal(tokenResponse.status, 400);
      assert.equal(tokenResponse.json.error, 'invalid_grant');
    });

    await t.test('admin consent revocation applies to realm users and forces consent', async () => {
      const aliceId = userId(env, 'alice');
      clearConsent(env, { username: 'alice', realm: 'acme', clientId: 'internal-app' });
      const admin = await adminToken('it@acme.test');
      const redirectUri = `${origin('app.acme.localhost')}/callback`;

      try {
        const alice = await accessToken(acme, {
          clientId: 'internal-app',
          identifier: 'alice@acme.test',
          redirectUri,
        });

        const before = withSystemDatabase(env, (database) =>
          database
            .prepare(
              `SELECT revoked_at
                 FROM client_consents
                WHERE user_id = ?
                  AND realm_id = (SELECT id FROM realms WHERE slug = 'acme')
                  AND client_id = 'internal-app'`
            )
            .get(aliceId)
        );
        assert.equal(before.revoked_at, null);

        const revoked = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/realms/acme/users/${aliceId}/consents/internal-app`,
          bearer: admin.access_token,
        });
        assert.equal(revoked.status, 200);
        assert.equal(revoked.json.ok, true);
        assert.equal(revoked.json.consent.client_id, 'internal-app');
        assert.ok(revoked.json.consent.revoked_at);
        assert.deepEqual(revoked.json.consent.scopes, ['openid', 'profile']);

        const repeated = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/realms/acme/users/${aliceId}/consents/internal-app`,
          bearer: admin.access_token,
        });
        assert.equal(repeated.status, 200);

        const { challenge } = pkce();
        const authorizePath =
          `/oidc/internal-app/authorize?response_type=code&client_id=internal-app` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20profile` +
          `&state=admin-revoked&code_challenge=${challenge}&code_challenge_method=S256`;
        const prompt = await acme({ path: authorizePath, cookie: alice.cookie });
        assert.equal(prompt.status, 302);
        assert.equal(locationQuery(prompt).pathname, '/oidc/internal-app/consent');
      } finally {
        clearConsent(env, {
          username: 'alice',
          realm: 'acme',
          clientId: 'internal-app',
        });
      }
    });

    await t.test('admin consent revocation forces a prompt for trusted clients', async () => {
      setConsentMode(env, {
        realm: 'acme',
        clientId: 'acme-members-app',
        mode: 'trusted',
      });
      clearConsent(env, {
        username: 'alice',
        realm: 'acme',
        clientId: 'acme-members-app',
      });
      const aliceId = userId(env, 'alice');
      const admin = await adminToken('it@acme.test');

      try {
        const revoked = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/realms/acme/users/${aliceId}/consents/acme-members-app`,
          bearer: admin.access_token,
        });
        assert.equal(revoked.status, 200);
        assert.ok(revoked.json.consent.revoked_at);

        const login = await acme({
          method: 'POST',
          path: '/api/v1/login/password',
          body: {
            client_id: 'acme-members-app',
            identifier: 'alice@acme.test',
            password: 'demo',
          },
        });
        const jar = mergeCookies('', login);
        const { challenge } = pkce();
        const authorizePath =
          `/oidc/acme-members-app/authorize?response_type=code` +
          `&client_id=acme-members-app&redirect_uri=${encodeURIComponent(
            `${origin('members.localhost')}/callback`
          )}&scope=openid%20email&state=trusted-revoked` +
          `&code_challenge=${challenge}&code_challenge_method=S256`;
        const prompt = await acme({ path: authorizePath, cookie: jar });
        assert.equal(prompt.status, 302);
        assert.equal(
          locationQuery(prompt).pathname,
          '/oidc/acme-members-app/consent'
        );
      } finally {
        setConsentMode(env, {
          realm: 'acme',
          clientId: 'acme-members-app',
          mode: 'remembered',
        });
        clearConsent(env, {
          username: 'alice',
          realm: 'acme',
          clientId: 'acme-members-app',
        });
      }
    });

    await t.test('exact app bans block authorization, code exchange and userinfo', async () => {
      const aliceId = userId(env, 'alice');
      const acmeId = realmId(env, 'acme');
      const itId = userId(env, 'acme-it');
      const redirectUri = `${origin('app.acme.localhost')}/callback`;
      clearConsent(env, { username: 'alice', realm: 'acme', clientId: 'internal-app' });
      clearBans(env, { username: 'alice', realm: 'acme' });
      const admin = await adminToken('it@acme.test');

      try {
        const alice = await accessToken(acme, {
          clientId: 'internal-app',
          identifier: 'alice@acme.test',
          redirectUri,
        });
        const beforeUserinfo = await acme({
          path: '/oidc/internal-app/userinfo',
          bearer: alice.access_token,
        });
        assert.equal(beforeUserinfo.status, 200);

        const { verifier, challenge } = pkce();
        const authorizePath =
          `/oidc/internal-app/authorize?response_type=code&client_id=internal-app` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20profile` +
          `&state=exact-ban-code&code_challenge=${challenge}` +
          `&code_challenge_method=S256`;
        const approved = await completeAuthorization(acme, {
          path: authorizePath,
          cookie: alice.cookie,
          clientId: 'internal-app',
        });
        const code = locationQuery(approved.response).searchParams.get('code');
        assert.ok(code);

        const sessionId = activeSessionId(env, alice.cookie);
        const refreshId = insertRefreshToken(env, {
          sessionId,
          userId: aliceId,
          realmId: acmeId,
          clientId: 'internal-app',
        });

        const ban = await identity({
          method: 'POST',
          path: `/api/v1/admin/realms/acme/users/${aliceId}/bans`,
          bearer: admin.access_token,
          body: { client_id: 'internal-app' },
        });
        assert.equal(ban.status, 200);
        assert.equal(ban.json.ok, true);
        assert.equal(ban.json.ban.user_id, aliceId);
        assert.equal(ban.json.ban.client_id, 'internal-app');
        assert.equal(ban.json.ban.created_by, itId);
        assert.ok(ban.json.ban.created_at);

        const duplicate = await identity({
          method: 'POST',
          path: `/api/v1/admin/realms/acme/users/${aliceId}/bans`,
          bearer: admin.access_token,
          body: { client_id: 'internal-app' },
        });
        assert.equal(duplicate.status, 200);
        assert.equal(duplicate.json.ban.created_at, ban.json.ban.created_at);

        const stored = withRealmDatabase(env, 'acme', (database) =>
          database
            .prepare(
              'SELECT user_id, client_id, created_by, created_at FROM app_bans WHERE user_id = ? AND client_id = ?'
            )
            .get(aliceId, 'internal-app')
        );
        assert.equal(stored.created_by, itId);

        const storedRefresh = withSystemDatabase(env, (database) =>
          database.prepare('SELECT revoked_at FROM refresh_tokens WHERE id = ?').get(refreshId)
        );
        assert.ok(storedRefresh.revoked_at);

        withSystemDatabase(env, (database) => {
          database
            .prepare(
              `UPDATE client_consents
                  SET revoked_at = NULL
                WHERE user_id = ? AND realm_id = ? AND client_id = 'internal-app'`
            )
            .run(aliceId, acmeId);
        });

        const bannedUserinfo = await acme({
          path: '/oidc/internal-app/userinfo',
          bearer: alice.access_token,
        });
        assert.equal(bannedUserinfo.status, 401);
        assert.equal(bannedUserinfo.json.error, 'invalid_token');

        const tokenResponse = await acme({
          method: 'POST',
          path: '/oidc/internal-app/token',
          form: {
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: 'internal-app',
            code_verifier: verifier,
          },
        });
        assert.equal(tokenResponse.status, 400);
        assert.equal(tokenResponse.json.error, 'invalid_grant');

        const denied = await acme({ path: authorizePath, cookie: alice.cookie });
        assert.equal(denied.status, 302);
        assert.equal(locationQuery(denied).searchParams.get('error'), 'access_denied');

        const adminSessions = await identity({
          path: '/api/v1/admin/realms/acme/sessions',
          bearer: admin.access_token,
        });
        assert.equal(adminSessions.status, 200);

        const revoked = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/realms/acme/users/${aliceId}/consents/internal-app`,
          bearer: admin.access_token,
        });
        assert.equal(revoked.status, 200);

        const unbanned = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/realms/acme/users/${aliceId}/bans/internal-app`,
          bearer: admin.access_token,
        });
        assert.equal(unbanned.status, 200);
        assert.equal(unbanned.json.removed, true);

        const prompt = await acme({ path: authorizePath, cookie: alice.cookie });
        assert.equal(prompt.status, 302);
        assert.equal(locationQuery(prompt).pathname, '/oidc/internal-app/consent');
      } finally {
        clearBans(env, { username: 'alice', realm: 'acme' });
        clearConsent(env, {
          username: 'alice',
          realm: 'acme',
          clientId: 'internal-app',
        });
      }
    });

    await t.test('wildcard app bans block every client in the realm only', async () => {
      const aliceId = userId(env, 'alice');
      const acmeId = realmId(env, 'acme');
      const acmeRedirect = `${origin('app.acme.localhost')}/callback`;
      clearConsent(env, { username: 'alice', realm: 'acme', clientId: 'internal-app' });
      clearConsent(env, {
        username: 'alice',
        realm: 'acme',
        clientId: 'acme-public-app',
      });
      clearConsent(env, {
        username: 'alice',
        realm: 'globex',
        clientId: 'globex-members-app',
      });
      clearBans(env, { username: 'alice', realm: 'acme' });
      const admin = await adminToken('it@acme.test');

      try {
        const alice = await accessToken(acme, {
          clientId: 'internal-app',
          identifier: 'alice@acme.test',
          redirectUri: acmeRedirect,
        });
        const account = await accessToken(acme, {
          clientId: 'account',
          identifier: 'alice@acme.test',
          redirectUri: `${origin('acme.localhost')}/app/account/callback`,
        });
        assert.ok(account.refresh_token);

        const ban = await identity({
          method: 'POST',
          path: `/api/v1/admin/realms/acme/users/${aliceId}/bans`,
          bearer: admin.access_token,
          body: { client_id: '*' },
        });
        assert.equal(ban.status, 200);
        assert.equal(ban.json.ban.client_id, '*');

        const accountRefresh = withSystemDatabase(env, (database) =>
          database
            .prepare(
              `SELECT revoked_at
                 FROM refresh_tokens
                WHERE user_id = ? AND realm_id = ? AND client_id = 'account'
                ORDER BY created_at DESC
                LIMIT 1`
            )
            .get(aliceId, acmeId)
        );
        assert.equal(accountRefresh.revoked_at, null);

        const accountRefreshed = await acme({
          method: 'POST',
          path: '/oidc/account/token',
          form: {
            grant_type: 'refresh_token',
            client_id: 'account',
            refresh_token: account.refresh_token,
          },
        });
        assert.equal(accountRefreshed.status, 200);
        assert.ok(accountRefreshed.json.access_token);

        const internal = pkce();
        const internalPath =
          `/oidc/internal-app/authorize?response_type=code&client_id=internal-app` +
          `&redirect_uri=${encodeURIComponent(acmeRedirect)}&scope=openid%20profile` +
          `&state=wildcard-internal&code_challenge=${internal.challenge}` +
          `&code_challenge_method=S256`;
        const deniedInternal = await acme({ path: internalPath, cookie: alice.cookie });
        assert.equal(deniedInternal.status, 302);
        assert.equal(
          locationQuery(deniedInternal).searchParams.get('error'),
          'access_denied'
        );

        const publicRequest = pkce();
        const publicPath =
          `/oidc/acme-public-app/authorize?response_type=code` +
          `&client_id=acme-public-app&redirect_uri=${encodeURIComponent(
            `${origin('public.localhost')}/callback`
          )}&scope=openid&state=wildcard-public` +
          `&code_challenge=${publicRequest.challenge}&code_challenge_method=S256`;
        const deniedPublic = await acme({ path: publicPath, cookie: alice.cookie });
        assert.equal(deniedPublic.status, 302);
        assert.equal(locationQuery(deniedPublic).searchParams.get('error'), 'access_denied');

        const globexToken = await accessToken(globex, {
          clientId: 'globex-members-app',
          identifier: 'alice@acme.test',
          redirectUri: `${origin('members.localhost')}/callback`,
        });
        assert.ok(globexToken.access_token);

        const removed = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/realms/acme/users/${aliceId}/bans/*`,
          bearer: admin.access_token,
        });
        assert.equal(removed.status, 200);
        assert.equal(removed.json.removed, true);

        const next = pkce();
        const nextPath =
          `/oidc/internal-app/authorize?response_type=code&client_id=internal-app` +
          `&redirect_uri=${encodeURIComponent(acmeRedirect)}&scope=openid%20profile` +
          `&state=wildcard-unbanned&code_challenge=${next.challenge}` +
          `&code_challenge_method=S256`;
        const prompt = await acme({ path: nextPath, cookie: alice.cookie });
        assert.equal(prompt.status, 302);
        assert.equal(locationQuery(prompt).pathname, '/oidc/internal-app/consent');
      } finally {
        clearBans(env, { username: 'alice', realm: 'acme' });
        clearConsent(env, { username: 'alice', realm: 'acme', clientId: 'internal-app' });
        clearConsent(env, {
          username: 'alice',
          realm: 'acme',
          clientId: 'acme-public-app',
        });
        clearConsent(env, {
          username: 'alice',
          realm: 'globex',
          clientId: 'globex-members-app',
        });
      }
    });

    await t.test('admin consent and ban APIs enforce target scope', async () => {
      const aliceId = userId(env, 'alice');
      const admin = await adminToken('it@acme.test');

      try {
        const crossRealm = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/realms/globex/users/${aliceId}/consents/globex-members-app`,
          bearer: admin.access_token,
        });
        assert.equal(crossRealm.status, 403);

        const unknownUser = await identity({
          method: 'DELETE',
          path: '/api/v1/admin/realms/acme/users/missing-user/consents/internal-app',
          bearer: admin.access_token,
        });
        assert.equal(unknownUser.status, 404);
        assert.equal(unknownUser.json.error.code, 'user_not_found');

        const crossClient = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/realms/acme/users/${aliceId}/consents/globex-members-app`,
          bearer: admin.access_token,
        });
        assert.equal(crossClient.status, 404);
        assert.equal(crossClient.json.error.code, 'client_not_found');

        const systemClient = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/realms/acme/users/${aliceId}/consents/admin`,
          bearer: admin.access_token,
        });
        assert.equal(systemClient.status, 404);
        assert.equal(systemClient.json.error.code, 'client_not_found');

        const missingBody = await identity({
          method: 'POST',
          path: `/api/v1/admin/realms/acme/users/${aliceId}/bans`,
          bearer: admin.access_token,
        });
        assert.equal(missingBody.status, 400);
        assert.equal(missingBody.json.error.code, 'invalid_request');

        const missingBan = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/realms/acme/users/${aliceId}/bans/internal-app`,
          bearer: admin.access_token,
        });
        assert.equal(missingBan.status, 404);
        assert.equal(missingBan.json.error.code, 'ban_not_found');

        const systemAdmin = await adminToken();
        const systemBan = await identity({
          method: 'POST',
          path: `/api/v1/admin/realms/globex/users/${aliceId}/bans`,
          bearer: systemAdmin.access_token,
          body: { client_id: '*' },
        });
        assert.equal(systemBan.status, 200);
        assert.equal(systemBan.json.ban.client_id, '*');

        const systemUnban = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/realms/globex/users/${aliceId}/bans/*`,
          bearer: systemAdmin.access_token,
        });
        assert.equal(systemUnban.status, 200);
      } finally {
        clearBans(env, { username: 'alice', realm: 'acme' });
        clearBans(env, { username: 'alice', realm: 'globex' });
        clearConsent(env, {
          username: 'alice',
          realm: 'globex',
          clientId: 'globex-members-app',
        });
      }
    });

    await t.test('admin user directory and app restrictions are realm scoped', async () => {
      const admin = await adminToken('it@acme.test');
      const systemAdmin = await adminToken();
      const aliceId = userId(env, 'alice');
      const acmeId = realmId(env, 'acme');
      const adminId = userId(env, 'admin');

      clearBans(env, { username: 'alice', realm: 'acme' });
      clearConsent(env, { username: 'alice', realm: 'acme', clientId: 'internal-app' });
      clearConsent(env, {
        username: 'alice',
        realm: 'acme',
        clientId: 'acme-members-app',
      });

      try {
        setAdminConsent(env, {
          username: 'alice',
          realm: 'acme',
          clientId: 'internal-app',
          scopes: 'openid profile',
          grantedVia: 'trusted',
        });
        const revokedAt = setAdminConsent(env, {
          username: 'alice',
          realm: 'acme',
          clientId: 'acme-members-app',
          scopes: '',
          revokedAt: Date.now(),
        });

        withRealmDatabase(env, 'acme', (database) => {
          database
            .prepare(
              `INSERT INTO app_bans (user_id, client_id, created_by, created_at)
               VALUES (?, ?, ?, ?)`
            )
            .run(aliceId, 'internal-app', userId(env, 'acme-it'), Date.now());
        });

        const acmeUsers = await identity({
          path: '/api/v1/admin/realms/acme/users',
          bearer: admin.access_token,
        });
        assert.equal(acmeUsers.status, 200);
        assert.deepEqual(
          acmeUsers.json.users.map((user) => user.username).sort(),
          ['acme-it', 'alice', 'guest']
        );

        const acmeAlice = acmeUsers.json.users.find((user) => user.username === 'alice');
        assert.equal(acmeAlice.relationship, 'home');
        assert.equal(acmeAlice.membership_status, 'active');
        assert.equal(acmeAlice.email, 'alice@acme.test');
        assert.equal(acmeAlice.banned, true);
        assert.equal(acmeAlice.ban_count, 1);

        const acmeAdminUser = acmeUsers.json.users.find((user) => user.username === 'acme-it');
        assert.deepEqual(acmeAdminUser.roles, ['realm-admin']);

        const acmeGuest = acmeUsers.json.users.find((user) => user.username === 'guest');
        assert.equal(acmeGuest.relationship, 'guest');

        const globexUsers = await identity({
          path: '/api/v1/admin/realms/globex/users',
          bearer: systemAdmin.access_token,
        });
        assert.equal(globexUsers.status, 200);
        assert.deepEqual(
          globexUsers.json.users.map((user) => user.username).sort(),
          ['alice', 'contractor']
        );

        const detail = await identity({
          path: `/api/v1/admin/realms/acme/users/${aliceId}`,
          bearer: admin.access_token,
        });
        assert.equal(detail.status, 200);
        assert.equal(detail.json.user.id, aliceId);
        assert.equal(detail.json.user.relationship, 'home');
        assert.equal(detail.json.user.home_realm_id, acmeId);
        assert.equal(detail.json.user.banned, true);

        const internalConsent = detail.json.consents.find(
          (consent) => consent.client_id === 'internal-app'
        );
        assert.equal(internalConsent.active, true);
        assert.equal(internalConsent.granted_via, 'trusted');
        assert.deepEqual(internalConsent.scopes, ['openid', 'profile']);
        assert.equal(internalConsent.client_name, 'Internal App');

        const revokedConsent = detail.json.consents.find(
          (consent) => consent.client_id === 'acme-members-app'
        );
        assert.equal(revokedConsent.active, false);
        assert.equal(revokedConsent.revoked_at, revokedAt);
        assert.deepEqual(revokedConsent.scopes, []);

        const ban = detail.json.bans.find((item) => item.client_id === 'internal-app');
        assert.equal(ban.client_name, 'Internal App');
        assert.equal(ban.created_by_username, 'acme-it');

        const outsiderDetail = await identity({
          path: `/api/v1/admin/realms/acme/users/${adminId}`,
          bearer: admin.access_token,
        });
        assert.equal(outsiderDetail.status, 404);
        assert.equal(outsiderDetail.json.error.code, 'user_not_found');

        const outsiderBan = await identity({
          method: 'POST',
          path: `/api/v1/admin/realms/acme/users/${adminId}/bans`,
          bearer: admin.access_token,
          body: { client_id: '*' },
        });
        assert.equal(outsiderBan.status, 404);
        assert.equal(outsiderBan.json.error.code, 'user_not_found');
        assert.equal(
          withRealmDatabase(env, 'acme', (database) =>
            database.prepare('SELECT COUNT(*) AS count FROM app_bans WHERE user_id = ?').get(adminId).count
          ),
          0
        );
      } finally {
        clearBans(env, { username: 'alice', realm: 'acme' });
        clearConsent(env, { username: 'alice', realm: 'acme', clientId: 'internal-app' });
        clearConsent(env, {
          username: 'alice',
          realm: 'acme',
          clientId: 'acme-members-app',
        });
      }
    });

    await t.test('system admins can manage users outside a realm', async () => {
      const acmeAdmin = await adminToken('it@acme.test');
      const systemAdmin = await adminToken();
      const aliceId = userId(env, 'alice');

      const acmeMe = await identity({
        path: '/api/v1/admin/me',
        bearer: acmeAdmin.access_token,
      });
      assert.equal(acmeMe.status, 200);
      assert.equal(acmeMe.json.user.is_system_admin, false);

      const systemMe = await identity({
        path: '/api/v1/admin/me',
        bearer: systemAdmin.access_token,
      });
      assert.equal(systemMe.status, 200);
      assert.equal(systemMe.json.user.is_system_admin, true);

      const forbidden = await identity({
        path: '/api/v1/admin/users',
        bearer: acmeAdmin.access_token,
      });
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.json.error.code, 'forbidden');

      const users = await identity({
        path: '/api/v1/admin/users',
        bearer: systemAdmin.access_token,
      });
      assert.equal(users.status, 200);
      const usernames = users.json.users.map((user) => user.username);
      assert.ok(usernames.includes('alice'));
      assert.ok(usernames.includes('admin'));

      const globalAlice = users.json.users.find((user) => user.username === 'alice');
      assert.equal(globalAlice.home_realm_slug, 'acme');
      assert.equal(globalAlice.membership_count, 2);

      const globalAdmin = users.json.users.find((user) => user.username === 'admin');
      assert.equal(globalAdmin.home_realm_slug, null);
      assert.equal(globalAdmin.membership_count, 0);
      assert.equal(globalAdmin.is_system_admin, true);

      const overview = await identity({
        path: `/api/v1/admin/users/${aliceId}`,
        bearer: systemAdmin.access_token,
      });
      assert.equal(overview.status, 200);
      assert.deepEqual(
        overview.json.memberships.map((membership) => [membership.slug, membership.relationship]).sort(),
        [['acme', 'home'], ['globex', 'guest']]
      );
    });

    await t.test('system admins can use the admin client on the canonical host', async () => {
      const admin = await adminToken();
      assert.ok(admin.access_token);
      assert.ok(admin.refresh_token);

      const discovery = await identity({ path: '/oidc/admin/openid-configuration' });
      assert.equal(discovery.status, 200);
      assert.equal(discovery.json.issuer, publicUrl);
      assert.ok(discovery.json.grant_types_supported.includes('refresh_token'));

      const userinfo = await identity({
        path: '/oidc/admin/userinfo',
        bearer: admin.access_token,
      });
      assert.equal(userinfo.status, 200);
      assert.equal(userinfo.json.preferred_username, 'admin');
      assert.equal(userinfo.json.is_system_admin, true);

      const refreshed = await identity({
        method: 'POST',
        path: '/oidc/admin/token',
        form: {
          grant_type: 'refresh_token',
          client_id: 'admin',
          refresh_token: admin.refresh_token,
        },
      });
      assert.equal(refreshed.status, 200);
      assert.ok(refreshed.json.access_token);
      assert.ok(refreshed.json.refresh_token);
      assert.notEqual(refreshed.json.refresh_token, admin.refresh_token);

      const reused = await identity({
        method: 'POST',
        path: '/oidc/admin/token',
        form: {
          grant_type: 'refresh_token',
          client_id: 'admin',
          refresh_token: admin.refresh_token,
        },
      });
      assert.equal(reused.status, 400);
      assert.equal(reused.json.error, 'invalid_grant');

      const revoked = await identity({
        method: 'POST',
        path: '/oidc/admin/token',
        form: {
          grant_type: 'refresh_token',
          client_id: 'admin',
          refresh_token: refreshed.json.refresh_token,
        },
      });
      assert.equal(revoked.status, 400);
    });

    await t.test('a new authorization request replaces a stale pending request', async () => {
      const redirectUri = `${origin('identity.test')}/app/admin/callback`;
      const stale = pkce();
      const fresh = pkce();
      const authorizePath = (state, challenge) =>
        `/oidc/admin/authorize?response_type=code&client_id=admin` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20profile` +
        `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;

      const first = await identity({ path: authorizePath('stale', stale.challenge) });
      assert.equal(first.status, 302);
      let jar = mergeCookies('', first);

      const second = await identity({
        path: authorizePath('fresh', fresh.challenge),
        cookie: jar,
      });
      assert.equal(second.status, 302);
      const loginRedirect = locationQuery(second);
      assert.equal(loginRedirect.pathname, '/oidc/admin/login');
      assert.equal(loginRedirect.searchParams.get('error'), null);
      jar = mergeCookies(jar, second);

      const login = await identity({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'admin', identifier: 'admin@system.test', password: 'demo' },
        cookie: jar,
      });
      assert.equal(login.status, 200);
      assert.equal(login.json.pending_auth_request, true);
      jar = mergeCookies(jar, login);

      const third = await identity({
        path: authorizePath('fresh', fresh.challenge).split('?')[0],
        cookie: jar,
      });
      assert.equal(third.status, 302);
      const redirected = locationQuery(third);
      assert.equal(redirected.searchParams.get('state'), 'fresh');
      assert.ok(redirected.searchParams.get('code'));
    });

    await t.test('configured static app callbacks are accepted', async () => {
      const admin = await accessToken(identity, {
        clientId: 'admin',
        identifier: 'admin@system.test',
        redirectUri: `http://admin.test:${port}/callback`,
      });
      assert.ok(admin.access_token);

      const account = await accessToken(identity, {
        clientId: 'account',
        identifier: 'guest@personal.test',
        redirectUri: `http://account.test:${port}/callback`,
      });
      assert.ok(account.access_token);
    });

    await t.test('split apps are served on their allowed hosts', async (t) => {
      const admin = await identity({ path: '/app/admin' });
      if (admin.status === 503) {
        t.skip('app builds are not available');
        return;
      }
      assert.equal(admin.status, 200);
      assert.match(admin.headers['content-type'], /text\/html/);
      assert.match(admin.text, /app-shell/);

      const adminRealm = await acme({ path: '/app/admin' });
      assert.equal(adminRealm.status, 404);

      const accountCanonical = await identity({ path: '/app/account' });
      assert.equal(accountCanonical.status, 200);
      assert.match(accountCanonical.text, /app-shell/);

      const accountRealm = await acme({ path: '/app/account' });
      assert.equal(accountRealm.status, 200);

      const accountClient = await app({ path: '/app/account' });
      assert.equal(accountClient.status, 200);

      const login = await identity({ path: '/oidc/admin/login' });
      assert.equal(login.status, 200);
      assert.match(login.text, /auth-page/);

      const loginRealm = await acme({ path: '/oidc/admin/login' });
      assert.equal(loginRealm.status, 404);
    });

    await t.test('account clients work for guests on canonical and realm hosts', async (t) => {
      const canonical = await identity({ path: '/oidc/account/openid-configuration' });
      assert.equal(canonical.status, 200);
      assert.equal(canonical.json.issuer, publicUrl);

      const realmHost = await acme({ path: '/oidc/account/openid-configuration' });
      assert.equal(realmHost.status, 200);
      assert.equal(realmHost.json.issuer, publicUrl);

      const clientHost = await app({ path: '/oidc/account/openid-configuration' });
      assert.equal(clientHost.status, 404);

      const account = await accessToken(acme, {
        clientId: 'account',
        identifier: 'guest@personal.test',
        redirectUri: `${origin('acme.localhost')}/app/account/callback`,
      });
      assert.ok(account.access_token);
      assert.ok(account.refresh_token);

      const userinfo = await acme({
        path: '/oidc/account/userinfo',
        bearer: account.access_token,
      });
      assert.equal(userinfo.status, 200);
      assert.equal(userinfo.json.preferred_username, 'guest');

      const refreshed = await acme({
        method: 'POST',
        path: '/oidc/account/token',
        form: {
          grant_type: 'refresh_token',
          client_id: 'account',
          refresh_token: account.refresh_token,
        },
      });
      assert.equal(refreshed.status, 200);
      assert.ok(refreshed.json.refresh_token);
    });

    await t.test('admin realm APIs list only accessible realms', async () => {
      const missing = await identity({ path: '/api/v1/admin/realms' });
      assert.equal(missing.status, 401);
      assert.equal(missing.json.error.code, 'invalid_token');

      const alice = await accessToken(acme, {
        clientId: 'internal-app',
        identifier: 'alice@acme.test',
        redirectUri: `${origin('app.acme.localhost')}/callback`,
      });
      const wrongAudience = await identity({
        path: '/api/v1/admin/realms',
        bearer: alice.access_token,
      });
      assert.equal(wrongAudience.status, 401);
      assert.equal(wrongAudience.json.error.code, 'invalid_token');

      const realmHost = await acme({ path: '/api/v1/admin/realms' });
      assert.equal(realmHost.status, 404);

      const clientHost = await app({ path: '/api/v1/admin/realms' });
      assert.equal(clientHost.status, 404);

      const system = await identity({
        path: '/api/v1/admin/realms',
        bearer: (await adminToken()).access_token,
      });
      assert.equal(system.status, 200);
      assert.equal(system.headers['cache-control'], 'no-store');
      assert.deepEqual(
        system.json.realms.map((realm) => realm.slug),
        ['acme', 'globex']
      );
      assert.deepEqual(
        system.json.realms.map((realm) => realm.display_name),
        ['Acme', 'Globex']
      );

      const acmeAdmin = await identity({
        path: '/api/v1/admin/realms',
        bearer: (await adminToken('it@acme.test')).access_token,
      });
      assert.equal(acmeAdmin.status, 200);
      assert.deepEqual(
        acmeAdmin.json.realms.map((realm) => realm.slug),
        ['acme']
      );

      const globexAdmin = await identity({
        path: '/api/v1/admin/realms',
        bearer: (await adminToken('contractor@personal.test')).access_token,
      });
      assert.equal(globexAdmin.status, 200);
      assert.deepEqual(
        globexAdmin.json.realms.map((realm) => realm.slug),
        ['globex']
      );
    });

    await t.test('admin session APIs require an active admin token', async () => {
      const missing = await identity({ path: '/api/v1/admin/realms/acme/sessions' });
      assert.equal(missing.status, 401);
      assert.equal(missing.json.error.code, 'invalid_token');

      const alice = await accessToken(acme, {
        clientId: 'internal-app',
        identifier: 'alice@acme.test',
        redirectUri: `${origin('app.acme.localhost')}/callback`,
      });
      const wrongAudience = await identity({
        path: '/api/v1/admin/realms/acme/sessions',
        bearer: alice.access_token,
      });
      assert.equal(wrongAudience.status, 401);
      assert.equal(wrongAudience.json.error.code, 'invalid_token');
    });

    await t.test('realm admins see bound and home-realm sessions', async () => {
      const aliceLogin = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      assert.equal(aliceLogin.status, 200);
      const aliceCookie = mergeCookies('', aliceLogin);
      const alicePublicId = activeSessionPublicId(env, aliceCookie);

      const guest = await accessToken(acme, {
        clientId: 'acme-members-app',
        identifier: 'guest@personal.test',
        redirectUri: `${origin('members.localhost')}/callback`,
      });
      const guestPublicId = activeSessionPublicId(env, guest.cookie);

      const contractor = await accessToken(globex, {
        clientId: 'globex-members-app',
        identifier: 'contractor@personal.test',
        redirectUri: `${origin('members.localhost')}/callback`,
      });
      const contractorPublicId = activeSessionPublicId(env, contractor.cookie);

      const admin = await adminToken('it@acme.test');
      const response = await identity({
        path: '/api/v1/admin/realms/acme/sessions',
        bearer: admin.access_token,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'no-store');

      const aliceSession = response.json.sessions.find(
        (session) => session.public_id === alicePublicId
      );
      assert.equal(aliceSession.user.username, 'alice');
      assert.equal(aliceSession.revoked_at, null);
      assert.equal(aliceSession.can_terminate, true);
      assert.equal('id' in aliceSession, false);

      const guestSession = response.json.sessions.find(
        (session) => session.public_id === guestPublicId
      );
      assert.equal(guestSession.user.username, 'guest');
      assert.equal(guestSession.can_terminate, false);

      assert.equal(
        response.json.sessions.some(
          (session) => session.public_id === contractorPublicId
        ),
        false
      );
    });

    await t.test('guest realm admins can revoke realm access but not terminate', async () => {
      const admin = await adminToken('contractor@personal.test');
      const alice = await accessToken(globex, {
        clientId: 'globex-members-app',
        identifier: 'alice@acme.test',
        redirectUri: `${origin('members.localhost')}/callback`,
      });
      const alicePublicId = activeSessionPublicId(env, alice.cookie);

      const list = await identity({
        path: '/api/v1/admin/realms/globex/sessions',
        bearer: admin.access_token,
      });
      assert.equal(list.status, 200);
      assert.equal(
        list.json.sessions.find((session) => session.public_id === alicePublicId)
          .can_terminate,
        false
      );

      const revoked = await identity({
        method: 'DELETE',
        path: `/api/v1/admin/realms/globex/sessions/${alicePublicId}/realm`,
        bearer: admin.access_token,
      });
      assert.equal(revoked.status, 200);
      assert.ok(revoked.json.revoked_at);

      const { binding, actorId } = withSystemDatabase(env, (database) => {
        const actor = database
          .prepare('SELECT id FROM users WHERE username = ?')
          .get('contractor');
        const session = database
          .prepare('SELECT id FROM sessions WHERE public_id = ?')
          .get(alicePublicId);
        return {
          actorId: actor.id,
          binding: database
            .prepare(
              `SELECT sr.revoked_at, sr.revoked_by
                 FROM session_realms sr
                WHERE sr.session_id = ?
                  AND sr.realm_id = (SELECT id FROM realms WHERE slug = 'globex')`
            )
            .get(session.id),
        };
      });
      assert.ok(binding.revoked_at);
      assert.equal(binding.revoked_by, actorId);

      const { challenge } = pkce();
      const authorizePath =
        `/oidc/globex-members-app/authorize?response_type=code` +
        `&client_id=globex-members-app&redirect_uri=${encodeURIComponent(
          `${origin('members.localhost')}/callback`
        )}&scope=openid&state=reauth` +
        `&code_challenge=${challenge}&code_challenge_method=S256`;
      const reauth = await globex({ path: authorizePath, cookie: alice.cookie });
      assert.equal(reauth.status, 302);
      const reauthLocation = locationQuery(reauth);
      assert.equal(reauthLocation.pathname, '/oidc/globex-members-app/login');
      assert.equal(reauthLocation.searchParams.get('reauth'), '1');

      const terminate = await identity({
        method: 'DELETE',
        path: `/api/v1/admin/realms/globex/sessions/${alicePublicId}`,
        bearer: admin.access_token,
      });
      assert.equal(terminate.status, 403);
      assert.equal(terminate.json.error.code, 'forbidden');

      const stillSignedIn = await globex({
        path: '/api/v1/session',
        cookie: alice.cookie,
      });
      assert.equal(stillSignedIn.status, 200);
    });

    await t.test('home realm admins terminate only the selected session', async () => {
      const admin = await adminToken('it@acme.test');

      const aliceAcme = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      const aliceAcmeCookie = mergeCookies('', aliceAcme);
      const aliceAcmePublicId = activeSessionPublicId(env, aliceAcmeCookie);

      const aliceGlobex = await accessToken(globex, {
        clientId: 'globex-members-app',
        identifier: 'alice@acme.test',
        redirectUri: `${origin('members.localhost')}/callback`,
      });

      const terminated = await identity({
        method: 'DELETE',
        path: `/api/v1/admin/realms/acme/sessions/${aliceAcmePublicId}`,
        bearer: admin.access_token,
      });
      assert.equal(terminated.status, 200);
      assert.equal(terminated.json.ok, true);

      const acmeSession = await acme({
        path: '/api/v1/session',
        cookie: aliceAcmeCookie,
      });
      assert.equal(acmeSession.status, 401);

      const globexSession = await globex({
        path: '/api/v1/session',
        cookie: aliceGlobex.cookie,
      });
      assert.equal(globexSession.status, 200);

      const deleted = withSystemDatabase(env, (database) =>
        database
          .prepare('SELECT public_id FROM sessions WHERE public_id = ?')
          .get(aliceAcmePublicId)
      );
      assert.equal(deleted, undefined);
    });

    await t.test('terminating an inactive account keeps the active account', async () => {
      const aliceLogin = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      let cookie = mergeCookies('', aliceLogin);
      const itLogin = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'it@acme.test', password: 'demo' },
        cookie,
      });
      cookie = mergeCookies(cookie, itLogin);

      const group = await acme({ path: '/api/v1/session', cookie });
      const aliceAccount = group.json.accounts.find(
        (account) => account.user.username === 'alice'
      );

      const admin = await adminToken('it@acme.test');
      const terminated = await identity({
        method: 'DELETE',
        path: `/api/v1/admin/realms/acme/sessions/${aliceAccount.public_id}`,
        bearer: admin.access_token,
      });
      assert.equal(terminated.status, 200);

      const after = await acme({ path: '/api/v1/session', cookie });
      assert.equal(after.status, 200);
      assert.equal(after.json.user.username, 'acme-it');
      assert.deepEqual(
        after.json.accounts.map((account) => account.user.username),
        ['acme-it']
      );
    });

    await t.test('system admins can terminate guest sessions', async () => {
      const admin = await adminToken();
      const alice = await accessToken(globex, {
        clientId: 'globex-members-app',
        identifier: 'alice@acme.test',
        redirectUri: `${origin('members.localhost')}/callback`,
      });
      const alicePublicId = activeSessionPublicId(env, alice.cookie);

      const list = await identity({
        path: '/api/v1/admin/realms/globex/sessions',
        bearer: admin.access_token,
      });
      assert.equal(list.status, 200);
      assert.equal(
        list.json.sessions.find((session) => session.public_id === alicePublicId)
          .can_terminate,
        true
      );

      const terminated = await identity({
        method: 'DELETE',
        path: `/api/v1/admin/realms/globex/sessions/${alicePublicId}`,
        bearer: admin.access_token,
      });
      assert.equal(terminated.status, 200);

      const session = await globex({
        path: '/api/v1/session',
        cookie: alice.cookie,
      });
      assert.equal(session.status, 401);
    });

    await t.test('admin token sessions and realms are enforced', async () => {
      const admin = await adminToken('it@acme.test');
      const adminPublicId = activeSessionPublicId(env, admin.cookie);

      const otherRealm = await identity({
        path: '/api/v1/admin/realms/globex/sessions',
        bearer: admin.access_token,
      });
      assert.equal(otherRealm.status, 403);
      assert.equal(otherRealm.json.error.code, 'forbidden');

      const realmHost = await acme({
        path: '/api/v1/admin/realms/acme/sessions',
        bearer: admin.access_token,
      });
      assert.equal(realmHost.status, 404);

      const clientHost = await app({
        path: '/api/v1/admin/realms/acme/sessions',
        bearer: admin.access_token,
      });
      assert.equal(clientHost.status, 404);

      const canonical = await identity({
        path: '/api/v1/admin/realms/acme/sessions',
        bearer: admin.access_token,
      });
      assert.equal(canonical.status, 200);

      const terminated = await identity({
        method: 'DELETE',
        path: `/api/v1/admin/realms/acme/sessions/${adminPublicId}`,
        bearer: admin.access_token,
      });
      assert.equal(terminated.status, 200);

      const deadToken = await identity({
        path: '/api/v1/admin/realms/acme/sessions',
        bearer: admin.access_token,
      });
      assert.equal(deadToken.status, 401);
      assert.equal(deadToken.json.error.code, 'invalid_token');
    });

    await t.test('admin access is re-read from the realm database', async () => {
      const admin = await adminToken('it@acme.test');
      const actor = withSystemDatabase(env, (database) =>
        database.prepare('SELECT id FROM users WHERE username = ?').get('acme-it')
      );

      withRealmDatabase(env, 'acme', (database) => {
        const role = database
          .prepare('SELECT id FROM roles WHERE slug = ?')
          .get('realm-admin');
        database
          .prepare('DELETE FROM membership_roles WHERE user_id = ? AND role_id = ?')
          .run(actor.id, role.id);
      });

      try {
        const realms = await identity({
          path: '/api/v1/admin/realms',
          bearer: admin.access_token,
        });
        assert.equal(realms.status, 200);
        assert.deepEqual(realms.json.realms, []);

        const response = await identity({
          path: '/api/v1/admin/realms/acme/sessions',
          bearer: admin.access_token,
        });
        assert.equal(response.status, 403);
        assert.equal(response.json.error.code, 'forbidden');
      } finally {
        withRealmDatabase(env, 'acme', (database) => {
          const role = database
            .prepare('SELECT id FROM roles WHERE slug = ?')
            .get('realm-admin');
          database
            .prepare('INSERT INTO membership_roles (user_id, role_id) VALUES (?, ?)')
            .run(actor.id, role.id);
        });
      }
    });

    await t.test('admin clients list roles and create realm clients', async () => {
      const admin = await adminToken('it@acme.test');
      const roles = await adminRequest(admin, {
        path: '/api/v1/admin/realms/acme/roles',
      });
      assert.equal(roles.status, 200);
      assert.ok(roles.json.roles.some((role) => role.slug === 'realm-admin'));

      const list = await adminRequest(admin, {
        path: '/api/v1/admin/realms/acme/clients',
      });
      assert.equal(list.status, 200);
      const listed = new Map(list.json.clients.map((client) => [client.client_id, client]));
      assert.ok(listed.has('internal-app'));
      assert.equal(listed.has('admin'), false);
      assert.equal(listed.get('acme-public-app').has_secret, false);
      assert.equal(listed.get('confidential-app').has_secret, true);
      assert.equal(listed.get('confidential-app').logo_url, null);

      const clientId = 'admin-created-public';
      const oldUri = `${origin('created.localhost')}/callback`;
      const newUri = `${origin('created2.localhost')}/callback`;
      try {
        const created = await createAdminClient(admin, 'acme', {
          client_id: clientId,
          name: 'Admin Created Public',
          access_mode: 'members',
          redirect_uris: [oldUri],
          required_roles: ['realm-admin'],
        });
        assert.equal(created.status, 200);
        assert.equal(created.json.ok, true);
        assert.equal(created.json.client.client_id, clientId);
        assert.equal(created.json.client.required_roles.length, 1);
        assert.equal(created.json.client.require_pkce, true);
        assert.equal(created.json.client.logo_url, null);
        assert.equal(created.json.client_secret, undefined);

        const duplicate = await createAdminClient(admin, 'acme', {
          client_id: clientId,
          name: 'Duplicate',
          redirect_uris: [newUri],
        });
        assert.equal(duplicate.status, 409);
        assert.equal(duplicate.json.error.code, 'client_id_exists');

        const updated = await updateAdminClient(admin, 'acme', clientId, {
          name: 'Renamed Public',
          access_mode: 'public',
          redirect_uris: [newUri],
          required_roles: [],
        });
        assert.equal(updated.status, 200);
        assert.equal(updated.json.client.name, 'Renamed Public');
        assert.equal(updated.json.client.access_mode, 'public');
        assert.deepEqual(updated.json.client.required_roles, []);

        const { challenge } = pkce();
        const denied = await acme({
          path:
            `/oidc/${clientId}/authorize?response_type=code&client_id=${clientId}` +
            `&redirect_uri=${encodeURIComponent(oldUri)}&scope=openid&state=old-uri` +
            `&code_challenge=${challenge}&code_challenge_method=S256`,
        });
        assert.equal(denied.status, 400);
        assert.equal(denied.json.error, 'invalid_request');

        const token = await accessToken(acme, {
          clientId,
          identifier: 'alice@acme.test',
          redirectUri: newUri,
        });
        assert.ok(token.access_token);
      } finally {
        const cleanup = await deleteAdminClient(admin, 'acme', clientId);
        assert.ok(cleanup.status === 200 || cleanup.status === 404);
      }
    });

    await t.test('admin clients rotate confidential client secrets', async () => {
      const admin = await adminToken('it@acme.test');
      const clientId = 'admin-created-confidential';
      const redirectUri = `${origin('created-conf.localhost')}/callback`;
      try {
        const created = await createAdminClient(admin, 'acme', {
          client_id: clientId,
          name: 'Admin Created Confidential',
          access_mode: 'members',
          token_endpoint_auth_method: 'client_secret_basic',
          redirect_uris: [redirectUri],
        });
        assert.equal(created.status, 200);
        assert.match(created.json.client_secret, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(created.json.client.has_secret, true);

        const initial = await authorizeCodeForClient(acme, {
          clientId,
          identifier: 'alice@acme.test',
          redirectUri,
          state: 'conf-initial',
        });
        const initialToken = await acme({
          method: 'POST',
          path: `/oidc/${clientId}/token`,
          form: {
            grant_type: 'authorization_code',
            code: initial.code,
            redirect_uri: redirectUri,
            code_verifier: initial.verifier,
          },
          headers: {
            authorization: `Basic ${Buffer.from(`${clientId}:${created.json.client_secret}`).toString('base64')}`,
          },
        });
        assert.equal(initialToken.status, 200);

        const rotated = await adminRequest(admin, {
          method: 'POST',
          path: `/api/v1/admin/realms/acme/clients/${clientId}/secret`,
        });
        assert.equal(rotated.status, 200);
        assert.match(rotated.json.client_secret, /^[A-Za-z0-9_-]{43}$/);
        assert.notEqual(rotated.json.client_secret, created.json.client_secret);
        assert.equal(rotated.json.client.token_endpoint_auth_method, 'client_secret_basic');

        const second = await authorizeCodeForClient(acme, {
          clientId,
          identifier: 'alice@acme.test',
          redirectUri,
          state: 'conf-old-secret',
        });
        const oldDenied = await acme({
          method: 'POST',
          path: `/oidc/${clientId}/token`,
          form: {
            grant_type: 'authorization_code',
            code: second.code,
            redirect_uri: redirectUri,
            code_verifier: second.verifier,
          },
          headers: {
            authorization: `Basic ${Buffer.from(`${clientId}:${created.json.client_secret}`).toString('base64')}`,
          },
        });
        assert.equal(oldDenied.status, 401);
        assert.equal(oldDenied.json.error, 'invalid_client');

        const newAllowed = await acme({
          method: 'POST',
          path: `/oidc/${clientId}/token`,
          form: {
            grant_type: 'authorization_code',
            code: second.code,
            redirect_uri: redirectUri,
            code_verifier: second.verifier,
          },
          headers: {
            authorization: `Basic ${Buffer.from(`${clientId}:${rotated.json.client_secret}`).toString('base64')}`,
          },
        });
        assert.equal(newAllowed.status, 200);

        const cleared = await updateAdminClient(admin, 'acme', clientId, {
          token_endpoint_auth_method: 'none',
        });
        assert.equal(cleared.status, 200);
        assert.equal(cleared.json.client.has_secret, false);
        assert.equal(cleared.json.client.require_pkce, true);

        const discovery = await acme({ path: `/oidc/${clientId}/openid-configuration` });
        assert.deepEqual(discovery.json.token_endpoint_auth_methods_supported, ['none']);

        const publicAccess = await authorizeCodeForClient(acme, {
          clientId,
          identifier: 'alice@acme.test',
          redirectUri,
          state: 'conf-to-public',
        });
        const publicToken = await acme({
          method: 'POST',
          path: `/oidc/${clientId}/token`,
          form: {
            grant_type: 'authorization_code',
            code: publicAccess.code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: publicAccess.verifier,
          },
        });
        assert.equal(publicToken.status, 200);
      } finally {
        const cleanup = await deleteAdminClient(admin, 'acme', clientId);
        assert.ok(cleanup.status === 200 || cleanup.status === 404);
      }
    });

    await t.test('admin client APIs enforce validation and target scope', async () => {
      const acmeAdmin = await adminToken('it@acme.test');
      const systemAdmin = await adminToken();
      const redirectUri = `${origin('created-scope.localhost')}/callback`;

      const crossRealm = await adminRequest(acmeAdmin, {
        path: '/api/v1/admin/realms/globex/clients',
      });
      assert.equal(crossRealm.status, 403);

      const reserved = await createAdminClient(acmeAdmin, 'acme', {
        client_id: 'admin',
        name: 'Reserved',
        redirect_uris: [redirectUri],
      });
      assert.equal(reserved.status, 400);
      assert.equal(reserved.json.error.code, 'reserved_client_id');

      const invalidId = await createAdminClient(acmeAdmin, 'acme', {
        client_id: 'Bad App',
        name: 'Invalid',
        redirect_uris: [redirectUri],
      });
      assert.equal(invalidId.status, 400);
      assert.equal(invalidId.json.error.code, 'invalid_client_id');

      const invalidRedirect = await createAdminClient(acmeAdmin, 'acme', {
        client_id: 'admin-invalid-redirect',
        name: 'Invalid Redirect',
        redirect_uris: ['/relative'],
      });
      assert.equal(invalidRedirect.status, 400);
      assert.equal(invalidRedirect.json.error.code, 'invalid_request');

      const missingOpenid = await createAdminClient(acmeAdmin, 'acme', {
        client_id: 'admin-invalid-scope',
        name: 'Invalid Scope',
        scopes: 'email profile',
        redirect_uris: [redirectUri],
      });
      assert.equal(missingOpenid.status, 400);
      assert.equal(missingOpenid.json.error.code, 'invalid_request');

      const unknownRole = await createAdminClient(acmeAdmin, 'acme', {
        client_id: 'admin-unknown-role',
        name: 'Unknown Role',
        required_roles: ['missing-role'],
        redirect_uris: [redirectUri],
      });
      assert.equal(unknownRole.status, 400);
      assert.equal(unknownRole.json.error.code, 'unknown_role');

      const globalClient = 'admin-global-unique';
      try {
        const created = await createAdminClient(acmeAdmin, 'acme', {
          client_id: globalClient,
          name: 'Global Unique',
          redirect_uris: [redirectUri],
        });
        assert.equal(created.status, 200);

        const duplicate = await createAdminClient(systemAdmin, 'globex', {
          client_id: globalClient,
          name: 'Duplicate Realm',
          redirect_uris: [redirectUri],
        });
        assert.equal(duplicate.status, 409);
        assert.equal(duplicate.json.error.code, 'client_id_exists');

        const systemUpdate = await updateAdminClient(systemAdmin, 'acme', 'admin', {
          name: 'Cannot Update',
        });
        assert.equal(systemUpdate.status, 404);

        const missingUpdate = await updateAdminClient(acmeAdmin, 'acme', 'missing-client', {
          name: 'Missing',
        });
        assert.equal(missingUpdate.status, 404);

        const publicClient = 'admin-secret-patch';
        try {
          const publicCreated = await createAdminClient(acmeAdmin, 'acme', {
            client_id: publicClient,
            name: 'Public Patch',
            redirect_uris: [redirectUri],
          });
          assert.equal(publicCreated.status, 200);

          const secretRequired = await updateAdminClient(acmeAdmin, 'acme', publicClient, {
            token_endpoint_auth_method: 'client_secret_basic',
          });
          assert.equal(secretRequired.status, 409);
          assert.equal(secretRequired.json.error.code, 'client_secret_required');

          const pkceDenied = await updateAdminClient(acmeAdmin, 'acme', publicClient, {
            require_pkce: false,
          });
          assert.equal(pkceDenied.status, 400);
          assert.equal(pkceDenied.json.error.code, 'invalid_request');
        } finally {
          const cleanup = await deleteAdminClient(acmeAdmin, 'acme', publicClient);
          assert.ok(cleanup.status === 200 || cleanup.status === 404);
        }
      } finally {
        const cleanup = await deleteAdminClient(acmeAdmin, 'acme', globalClient);
        assert.ok(cleanup.status === 200 || cleanup.status === 404);
      }
    });

    await t.test('admin client deletion cleans related client state', async () => {
      const admin = await adminToken('it@acme.test');
      const clientId = 'admin-delete-flow';
      const host = 'delete-flow.localhost';
      const redirectUri = `${origin(host)}/callback`;
      const deleteRequest = (options = {}) =>
        request(port, { host: `${host}:${port}`, ...options });
      clearBans(env, { username: 'alice', realm: 'acme' });

      try {
        const created = await createAdminClient(admin, 'acme', {
          client_id: clientId,
          name: 'Delete Flow',
          access_mode: 'members',
          redirect_uris: [redirectUri],
        });
        assert.equal(created.status, 200);

        withSystemDatabase(env, (database) => {
          database
            .prepare(
              'INSERT INTO oidc_client_hosts (host, client_id, created_at) VALUES (?, ?, ?)'
            )
            .run(host, clientId, Date.now());
        });

        const login = await deleteRequest({
          method: 'POST',
          path: '/api/v1/login/password',
          body: { client_id: clientId, identifier: 'alice@acme.test', password: 'demo' },
        });
        assert.equal(login.status, 200);
        const cookie = mergeCookies('', login);
        const beforeSession = await deleteRequest({ path: '/api/v1/session', cookie });
        assert.equal(beforeSession.status, 200);
        assert.equal(beforeSession.json.scope.client_id, clientId);

        const { verifier, challenge } = pkce();
        const authorizePath =
          `/oidc/authorize?response_type=code&client_id=${clientId}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20profile` +
          `&state=delete-flow&code_challenge=${challenge}&code_challenge_method=S256`;
        const approved = await completeAuthorization(deleteRequest, {
          path: authorizePath,
          cookie,
          clientId,
        });
        const code = locationQuery(approved.response).searchParams.get('code');
        assert.ok(code);
        const token = await deleteRequest({
          method: 'POST',
          path: '/oidc/token',
          form: {
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: verifier,
          },
        });
        assert.equal(token.status, 200);

        const aliceId = userId(env, 'alice');
        const acmeId = realmId(env, 'acme');
        const sessionId = activeSessionId(env, cookie);
        insertRefreshToken(env, {
          sessionId,
          userId: aliceId,
          realmId: acmeId,
          clientId,
        });

        withRealmDatabase(env, 'acme', (database) => {
          const now = Date.now();
          database
            .prepare(
              `INSERT INTO app_bans (user_id, client_id, created_by, created_at)
               VALUES (?, ?, ?, ?)`
            )
            .run(aliceId, clientId, userId(env, 'acme-it'), now);
          database
            .prepare(
              `INSERT OR REPLACE INTO app_bans (user_id, client_id, created_by, created_at)
               VALUES (?, '*', ?, ?)`
            )
            .run(aliceId, userId(env, 'acme-it'), now);
          database
            .prepare(
              `INSERT INTO auth_requests
                (id, client_id, redirect_uri, scope, state, nonce, code_challenge,
                 code_challenge_method, session_id, user_id, auth_time, created_at,
                 expires_at, completed_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, NULL)`
            )
            .run('delete-flow-auth', clientId, redirectUri, 'openid', 'state', 'nonce', aliceId, now, now + 60_000);
          database
            .prepare(
              `INSERT INTO authorization_codes
                (id, auth_request_id, client_id, user_id, redirect_uri, scope, nonce,
                 code_challenge, code_challenge_method, session_id, auth_time, created_at,
                 expires_at, consumed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?, NULL)`
            )
            .run(
              'delete-flow-code',
              'delete-flow-code-request',
              clientId,
              aliceId,
              redirectUri,
              'openid',
              'nonce',
              now,
              now + 60_000
            );
        });

        const deleted = await deleteAdminClient(admin, 'acme', clientId);
        assert.equal(deleted.status, 200);
        assert.equal(deleted.json.removed, true);
        assert.equal(deleted.json.client_id, clientId);

        assert.equal(
          withSystemDatabase(env, (database) =>
            database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id = ?').get(sessionId).count
          ),
          0
        );
        assert.equal(
          withSystemDatabase(env, (database) =>
            database.prepare('SELECT COUNT(*) AS count FROM client_realms WHERE client_id = ?').get(clientId).count
          ),
          0
        );
        assert.equal(
          withSystemDatabase(env, (database) =>
            database.prepare('SELECT COUNT(*) AS count FROM oidc_client_hosts WHERE client_id = ?').get(clientId).count
          ),
          0
        );
        assert.equal(
          withSystemDatabase(env, (database) =>
            database.prepare('SELECT COUNT(*) AS count FROM client_consents WHERE client_id = ?').get(clientId).count
          ),
          0
        );
        assert.equal(
          withSystemDatabase(env, (database) =>
            database.prepare('SELECT COUNT(*) AS count FROM refresh_tokens WHERE client_id = ?').get(clientId).count
          ),
          0
        );
        assert.equal(
          withRealmDatabase(env, 'acme', (database) =>
            database.prepare('SELECT COUNT(*) AS count FROM oidc_clients WHERE client_id = ?').get(clientId).count
          ),
          0
        );
        assert.equal(
          withRealmDatabase(env, 'acme', (database) =>
            database.prepare('SELECT COUNT(*) AS count FROM auth_requests WHERE client_id = ?').get(clientId).count
          ),
          0
        );
        assert.equal(
          withRealmDatabase(env, 'acme', (database) =>
            database.prepare('SELECT COUNT(*) AS count FROM authorization_codes WHERE client_id = ?').get(clientId).count
          ),
          0
        );
        assert.equal(
          withRealmDatabase(env, 'acme', (database) =>
            database.prepare('SELECT COUNT(*) AS count FROM app_bans WHERE client_id = ?').get(clientId).count
          ),
          0
        );
        assert.equal(
          withRealmDatabase(env, 'acme', (database) =>
            database.prepare(`SELECT COUNT(*) AS count FROM app_bans WHERE client_id = '*' AND user_id = ?`).get(aliceId).count
          ),
          1
        );

        const afterDelete = await acme({ path: `/oidc/${clientId}/openid-configuration` });
        assert.equal(afterDelete.status, 404);
      } finally {
        const cleanup = await deleteAdminClient(admin, 'acme', clientId);
        assert.ok(cleanup.status === 200 || cleanup.status === 404);
        clearBans(env, { username: 'alice', realm: 'acme' });
      }
    });

    await t.test('confidential clients authenticate with client_secret_basic', async () => {
      const { verifier, challenge } = pkce();
      const redirectUri = `${origin('confidential.localhost')}/callback`;
      const authorizePath =
        `/oidc/confidential-app/authorize?response_type=code&client_id=confidential-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email` +
        `&state=state-4&code_challenge=${challenge}&code_challenge_method=S256`;

      const first = await acme({ path: authorizePath });
      let jar = mergeCookies('', first);
      const login = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'confidential-app', identifier: 'alice@acme.test', password: 'demo' },
        cookie: jar,
      });
      jar = mergeCookies(jar, login);
      const second = await completeAuthorization(acme, {
        path: authorizePath,
        cookie: jar,
        clientId: 'confidential-app',
      });
      const code = locationQuery(second.response).searchParams.get('code');

      const tokenResponse = await acme({
        method: 'POST',
        path: '/oidc/confidential-app/token',
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        },
        headers: {
          authorization: `Basic ${Buffer.from('confidential-app:demo-secret').toString('base64')}`,
        },
      });
      assert.equal(tokenResponse.status, 200);
    });

    await t.test('logout removes only the current host session', async () => {
      const acmeLogin = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      const acmeCookie = mergeCookies('', acmeLogin);

      const globexLogin = await globex({
        method: 'POST',
        path: '/api/v1/login/password',
        body: {
          client_id: 'globex-members-app',
          identifier: 'contractor@personal.test',
          password: 'demo',
        },
      });
      const globexCookie = mergeCookies('', globexLogin);

      const logout = await acme({
        method: 'POST',
        path: '/api/v1/logout',
        body: {},
        cookie: acmeCookie,
      });
      assert.equal(logout.status, 200);

      const acmeSession = await acme({ path: '/api/v1/session', cookie: acmeCookie });
      assert.equal(acmeSession.status, 401);

      const globexSession = await globex({ path: '/api/v1/session', cookie: globexCookie });
      assert.equal(globexSession.status, 200);
    });

    await t.test('sessions require a cookie', async () => {
      const response = await acme({ path: '/api/v1/session' });
      assert.equal(response.status, 401);
      assert.equal(response.json.error.code, 'not_authenticated');
    });

    await t.test('admin realm membership management adds existing users', async () => {
      const acmeAdmin = await adminToken('it@acme.test');
      const contractor = await adminToken('contractor@personal.test');
      const carolId = insertTestUser(env, {
        username: 'carol',
        email: 'carol@external.test',
        displayName: 'Carol',
      });
      const danaId = insertTestUser(env, {
        username: 'dana',
        email: 'dana@external.test',
        displayName: 'Dana',
        status: 'disabled',
      });
      const aliceId = userId(env, 'alice');

      try {
        const lookupEmail = await adminRequest(acmeAdmin, {
          path: `/api/v1/admin/realms/acme/user-lookup?identifier=${encodeURIComponent('carol@external.test')}`,
        });
        assert.equal(lookupEmail.status, 200);
        assert.equal(lookupEmail.json.ok, true);
        assert.equal(lookupEmail.json.user.id, carolId);
        assert.equal(lookupEmail.json.user.username, 'carol');
        assert.equal(lookupEmail.json.user.relationship, 'none');
        assert.equal(lookupEmail.json.user.can_add, true);
        assert.equal(lookupEmail.json.user.reason, null);

        const lookupUsername = await adminRequest(acmeAdmin, {
          path: '/api/v1/admin/realms/acme/user-lookup?identifier=CAROL',
        });
        assert.equal(lookupUsername.status, 200);
        assert.equal(lookupUsername.json.user.id, carolId);

        const disabled = await adminRequest(acmeAdmin, {
          path: '/api/v1/admin/realms/acme/user-lookup?identifier=dana@external.test',
        });
        assert.equal(disabled.status, 200);
        assert.equal(disabled.json.user.status, 'disabled');
        assert.equal(disabled.json.user.can_add, false);
        assert.equal(disabled.json.user.reason, 'user_disabled');

        const existingHome = await adminRequest(acmeAdmin, {
          path: '/api/v1/admin/realms/acme/user-lookup?identifier=alice@acme.test',
        });
        assert.equal(existingHome.status, 200);
        assert.equal(existingHome.json.user.relationship, 'home');
        assert.equal(existingHome.json.user.can_add, false);
        assert.equal(existingHome.json.user.reason, 'already_member');

        const unknown = await adminRequest(acmeAdmin, {
          path: '/api/v1/admin/realms/acme/user-lookup?identifier=missing@external.test',
        });
        assert.equal(unknown.status, 404);
        assert.equal(unknown.json.error.code, 'user_not_found');

        const missingIdentifier = await adminRequest(acmeAdmin, {
          path: '/api/v1/admin/realms/acme/user-lookup',
        });
        assert.equal(missingIdentifier.status, 400);
        assert.equal(missingIdentifier.json.error.code, 'invalid_request');

        const foreignLookup = await identity({
          path: '/api/v1/admin/realms/acme/user-lookup?identifier=carol',
          bearer: contractor.access_token,
        });
        assert.equal(foreignLookup.status, 403);

        const foreignAdd = await identity({
          method: 'POST',
          path: '/api/v1/admin/realms/acme/users',
          bearer: contractor.access_token,
          body: { user_id: carolId },
        });
        assert.equal(foreignAdd.status, 403);

        const added = await adminRequest(acmeAdmin, {
          method: 'POST',
          path: '/api/v1/admin/realms/acme/users',
          body: { user_id: carolId },
        });
        assert.equal(added.status, 200);
        assert.equal(added.json.ok, true);
        assert.equal(added.json.user.id, carolId);
        assert.equal(added.json.user.relationship, 'guest');
        assert.equal(added.json.user.membership_status, 'active');
        assert.equal(added.json.permissions.can_manage_membership, true);

        const list = await adminRequest(acmeAdmin, {
          path: '/api/v1/admin/realms/acme/users',
        });
        assert.ok(list.json.users.some((user) => user.username === 'carol'));

        const detail = await adminRequest(acmeAdmin, {
          path: `/api/v1/admin/realms/acme/users/${carolId}`,
        });
        assert.equal(detail.status, 200);
        assert.equal(detail.json.user.username, 'carol');

        const alreadyMember = await adminRequest(acmeAdmin, {
          path: `/api/v1/admin/realms/acme/user-lookup?identifier=carol@external.test`,
        });
        assert.equal(alreadyMember.json.user.relationship, 'guest');
        assert.equal(alreadyMember.json.user.can_add, false);
        assert.equal(alreadyMember.json.user.reason, 'already_member');

        const duplicate = await adminRequest(acmeAdmin, {
          method: 'POST',
          path: '/api/v1/admin/realms/acme/users',
          body: { user_id: carolId },
        });
        assert.equal(duplicate.status, 409);
        assert.equal(duplicate.json.error.code, 'already_member');

        const disabledAdd = await adminRequest(acmeAdmin, {
          method: 'POST',
          path: '/api/v1/admin/realms/acme/users',
          body: { user_id: danaId },
        });
        assert.equal(disabledAdd.status, 409);
        assert.equal(disabledAdd.json.error.code, 'user_not_active');

        const homeRealmAdd = await adminRequest(acmeAdmin, {
          method: 'POST',
          path: '/api/v1/admin/realms/acme/users',
          body: { user_id: aliceId },
        });
        assert.equal(homeRealmAdd.status, 409);
        assert.equal(homeRealmAdd.json.error.code, 'already_member');

        const unknownAdd = await adminRequest(acmeAdmin, {
          method: 'POST',
          path: '/api/v1/admin/realms/acme/users',
          body: { user_id: crypto.randomUUID() },
        });
        assert.equal(unknownAdd.status, 404);

        const unknownField = await adminRequest(acmeAdmin, {
          method: 'POST',
          path: '/api/v1/admin/realms/acme/users',
          body: { user_id: crypto.randomUUID(), roles: [] },
        });
        assert.equal(unknownField.status, 400);
        assert.equal(unknownField.json.error.code, 'invalid_request');
      } finally {
        clearRealmMembership(env, 'acme', carolId);
        clearRealmMembership(env, 'acme', danaId);
      }
    });

    await t.test('admin membership suspension revokes realm access', async () => {
      const acmeAdmin = await adminToken('it@acme.test');
      const guestId = userId(env, 'guest');
      const acmeId = realmId(env, 'acme');
      const redirectUri = `${origin('members.localhost')}/callback`;
      clearConsent(env, { username: 'guest', realm: 'acme', clientId: 'acme-members-app' });
      clearBans(env, { username: 'guest', realm: 'acme' });
      clearUserRealmSessions(env, guestId);

      try {
        const guest = await accessToken(acme, {
          clientId: 'acme-members-app',
          identifier: 'guest@personal.test',
          redirectUri,
        });
        const sessionId = activeSessionId(env, guest.cookie);
        const refreshId = insertRefreshToken(env, {
          sessionId,
          userId: guestId,
          realmId: acmeId,
          clientId: 'acme-members-app',
        });

        const suspended = await adminRequest(acmeAdmin, {
          method: 'PATCH',
          path: `/api/v1/admin/realms/acme/users/${guestId}/membership`,
          body: { status: 'suspended' },
        });
        assert.equal(suspended.status, 200);
        assert.equal(suspended.json.user.membership_status, 'suspended');
        assert.ok(suspended.json.revoked.refresh_tokens >= 1);
        assert.ok(suspended.json.revoked.consents >= 1);
        assert.ok(suspended.json.revoked.session_realms >= 1);

        const consent = withSystemDatabase(env, (database) =>
          database
            .prepare(
              `SELECT revoked_at
                 FROM client_consents
                WHERE user_id = ? AND realm_id = ? AND client_id = 'acme-members-app'`
            )
            .get(guestId, acmeId)
        );
        assert.ok(consent.revoked_at);

        const refresh = withSystemDatabase(env, (database) =>
          database.prepare('SELECT revoked_at FROM refresh_tokens WHERE id = ?').get(refreshId)
        );
        assert.ok(refresh.revoked_at);

        const binding = withSystemDatabase(env, (database) =>
          database
            .prepare('SELECT revoked_at FROM session_realms WHERE session_id = ? AND realm_id = ?')
            .get(sessionId, acmeId)
        );
        assert.ok(binding.revoked_at);

        const { challenge } = pkce();
        const authorizePath =
          `/oidc/acme-members-app/authorize?response_type=code&client_id=acme-members-app` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid` +
          `&state=suspended-membership&code_challenge=${challenge}` +
          `&code_challenge_method=S256`;
        const denied = await acme({ path: authorizePath, cookie: guest.cookie });
        assert.equal(denied.status, 302);
        assert.equal(locationQuery(denied).searchParams.get('error'), 'access_denied');

        const restored = await adminRequest(acmeAdmin, {
          method: 'PATCH',
          path: `/api/v1/admin/realms/acme/users/${guestId}/membership`,
          body: { status: 'active' },
        });
        assert.equal(restored.status, 200);
        assert.equal(restored.json.user.membership_status, 'active');
        assert.deepEqual(restored.json.revoked, {
          consents: 0,
          refresh_tokens: 0,
          session_realms: 0,
        });

        const stillRevoked = withSystemDatabase(env, (database) =>
          database
            .prepare(
              `SELECT revoked_at
                 FROM client_consents
                WHERE user_id = ? AND realm_id = ? AND client_id = 'acme-members-app'`
            )
            .get(guestId, acmeId)
        );
        assert.ok(stillRevoked.revoked_at);

        const invalidStatus = await adminRequest(acmeAdmin, {
          method: 'PATCH',
          path: `/api/v1/admin/realms/acme/users/${guestId}/membership`,
          body: { status: 'invited' },
        });
        assert.equal(invalidStatus.status, 400);
        assert.equal(invalidStatus.json.error.code, 'invalid_membership_status');
      } finally {
        setTestMembershipStatus(env, 'acme', guestId, 'active');
        clearConsent(env, { username: 'guest', realm: 'acme', clientId: 'acme-members-app' });
        clearBans(env, { username: 'guest', realm: 'acme' });
        clearUserRealmSessions(env, guestId);
      }
    });

    await t.test('admin realm roles and last active admin protection', async () => {
      const acmeAdmin = await adminToken('it@acme.test');
      const systemAdmin = await adminToken();
      const guestId = userId(env, 'guest');
      const acmeItId = userId(env, 'acme-it');

      try {
        const invalidRole = await adminRequest(acmeAdmin, {
          method: 'PUT',
          path: `/api/v1/admin/realms/acme/users/${guestId}/roles`,
          body: { roles: ['does-not-exist'] },
        });
        assert.equal(invalidRole.status, 400);
        assert.equal(invalidRole.json.error.code, 'invalid_roles');

        const invalidShape = await adminRequest(acmeAdmin, {
          method: 'PUT',
          path: `/api/v1/admin/realms/acme/users/${guestId}/roles`,
          body: { roles: 'realm-admin' },
        });
        assert.equal(invalidShape.status, 400);
        assert.equal(invalidShape.json.error.code, 'invalid_request');

        const granted = await adminRequest(acmeAdmin, {
          method: 'PUT',
          path: `/api/v1/admin/realms/acme/users/${guestId}/roles`,
          body: { roles: ['realm-admin'] },
        });
        assert.equal(granted.status, 200);
        assert.deepEqual(granted.json.user.roles, ['realm-admin']);

        const guestAdmin = await adminToken('guest@personal.test');
        const suspendedOther = await adminRequest(guestAdmin, {
          method: 'PATCH',
          path: `/api/v1/admin/realms/acme/users/${acmeItId}/membership`,
          body: { status: 'suspended' },
        });
        assert.equal(suspendedOther.status, 200);
        assert.equal(suspendedOther.json.user.membership_status, 'suspended');

        const deniedAdmin = await adminRequest(acmeAdmin, {
          path: '/api/v1/admin/realms/acme/users',
        });
        assert.equal(deniedAdmin.status, 403);

        const restored = await adminRequest(systemAdmin, {
          method: 'PATCH',
          path: `/api/v1/admin/realms/acme/users/${acmeItId}/membership`,
          body: { status: 'active' },
        });
        assert.equal(restored.status, 200);
        assert.equal(restored.json.user.membership_status, 'active');

        const allowedAdmin = await adminRequest(acmeAdmin, {
          path: '/api/v1/admin/realms/acme/users',
        });
        assert.equal(allowedAdmin.status, 200);

        const removedSecondAdmin = await adminRequest(acmeAdmin, {
          method: 'PUT',
          path: `/api/v1/admin/realms/acme/users/${guestId}/roles`,
          body: { roles: [] },
        });
        assert.equal(removedSecondAdmin.status, 200);
        assert.deepEqual(removedSecondAdmin.json.user.roles, []);

        const lastAdminSuspend = await adminRequest(acmeAdmin, {
          method: 'PATCH',
          path: `/api/v1/admin/realms/acme/users/${acmeItId}/membership`,
          body: { status: 'suspended' },
        });
        assert.equal(lastAdminSuspend.status, 409);
        assert.equal(lastAdminSuspend.json.error.code, 'last_realm_admin');

        const lastAdminDemote = await adminRequest(acmeAdmin, {
          method: 'PUT',
          path: `/api/v1/admin/realms/acme/users/${acmeItId}/roles`,
          body: { roles: [] },
        });
        assert.equal(lastAdminDemote.status, 409);
        assert.equal(lastAdminDemote.json.error.code, 'last_realm_admin');

        const systemSuspend = await adminRequest(systemAdmin, {
          method: 'PATCH',
          path: `/api/v1/admin/realms/acme/users/${acmeItId}/membership`,
          body: { status: 'suspended' },
        });
        assert.equal(systemSuspend.status, 200);
        await adminRequest(systemAdmin, {
          method: 'PATCH',
          path: `/api/v1/admin/realms/acme/users/${acmeItId}/membership`,
          body: { status: 'active' },
        });
        const systemDemote = await adminRequest(systemAdmin, {
          method: 'PUT',
          path: `/api/v1/admin/realms/acme/users/${acmeItId}/roles`,
          body: { roles: [] },
        });
        assert.equal(systemDemote.status, 200);
        await adminRequest(systemAdmin, {
          method: 'PUT',
          path: `/api/v1/admin/realms/acme/users/${acmeItId}/roles`,
          body: { roles: ['realm-admin'] },
        });

        const detail = await adminRequest(acmeAdmin, {
          path: `/api/v1/admin/realms/acme/users/${acmeItId}`,
        });
        assert.equal(detail.json.permissions.is_self, true);
        assert.equal(detail.json.permissions.last_active_realm_admin, true);
        assert.equal(detail.json.permissions.can_remove_last_realm_admin, false);
        assert.equal(detail.json.permissions.can_suspend_membership, false);
        assert.equal(detail.json.permissions.reason, 'last_realm_admin');

        const systemDetail = await adminRequest(systemAdmin, {
          path: `/api/v1/admin/realms/acme/users/${acmeItId}`,
        });
        assert.equal(systemDetail.json.permissions.last_active_realm_admin, true);
        assert.equal(systemDetail.json.permissions.can_remove_last_realm_admin, true);
        assert.equal(systemDetail.json.permissions.can_suspend_membership, true);
      } finally {
        setTestMembershipStatus(env, 'acme', guestId, 'active');
        setTestMembershipStatus(env, 'acme', acmeItId, 'active');
        withRealmDatabase(env, 'acme', (database) => {
          database.prepare('DELETE FROM membership_roles WHERE user_id = ?').run(guestId);
          const role = database.prepare('SELECT id FROM roles WHERE slug = ?').get('realm-admin');
          const current = database
            .prepare('SELECT role_id FROM membership_roles WHERE user_id = ? AND role_id = ?')
            .get(acmeItId, role.id);
          if (!current) {
            database
              .prepare('INSERT INTO membership_roles (user_id, role_id) VALUES (?, ?)')
              .run(acmeItId, role.id);
          }
        });
        clearUserRealmSessions(env, guestId);
        clearUserRealmSessions(env, acmeItId);
      }
    });

    await t.test('admin realm settings update name and login behavior', async () => {
      const acmeAdmin = await adminToken('it@acme.test');
      const systemAdmin = await adminToken();
      let original = null;

      try {
        const initial = await adminRequest(acmeAdmin, {
          path: '/api/v1/admin/realms/acme/settings',
        });
        assert.equal(initial.status, 200);
        assert.equal(initial.json.settings.slug, 'acme');
        assert.equal(typeof initial.json.settings.created_at, 'number');
        original = initial.json.settings;

        const crossRealm = await adminRequest(acmeAdmin, {
          path: '/api/v1/admin/realms/globex/settings',
        });
        assert.equal(crossRealm.status, 403);

        const renamed = await adminRequest(acmeAdmin, {
          method: 'PATCH',
          path: '/api/v1/admin/realms/acme/settings',
          body: { display_name: '  Acme Inc  ' },
        });
        assert.equal(renamed.status, 200);
        assert.equal(renamed.json.ok, true);
        assert.equal(renamed.json.settings.display_name, 'Acme Inc');
        assert.equal(renamed.json.settings.allow_session_duration_choice, true);

        const realms = await adminRequest(systemAdmin, {
          path: '/api/v1/admin/realms',
        });
        assert.ok(
          realms.json.realms.some(
            (realm) => realm.slug === 'acme' && realm.display_name === 'Acme Inc'
          )
        );

        const publicRenamed = await acme({ path: '/api/v1/realm' });
        assert.equal(publicRenamed.json.display_name, 'Acme Inc');
        assert.equal(publicRenamed.json.allow_session_duration_choice, true);

        const disabledChoice = await adminRequest(systemAdmin, {
          method: 'PATCH',
          path: '/api/v1/admin/realms/acme/settings',
          body: { allow_session_duration_choice: false },
        });
        assert.equal(disabledChoice.status, 200);
        assert.equal(disabledChoice.json.settings.display_name, 'Acme Inc');
        assert.equal(disabledChoice.json.settings.allow_session_duration_choice, false);

        const publicDisabledChoice = await acme({ path: '/api/v1/realm' });
        assert.equal(publicDisabledChoice.json.display_name, 'Acme Inc');
        assert.equal(publicDisabledChoice.json.allow_session_duration_choice, false);

        const emptyPatch = await adminRequest(acmeAdmin, {
          method: 'PATCH',
          path: '/api/v1/admin/realms/acme/settings',
          body: {},
        });
        assert.equal(emptyPatch.status, 400);
        assert.equal(emptyPatch.json.error.code, 'invalid_request');

        for (const body of [
          { slug: 'globex' },
          { status: 'disabled' },
          { display_name: '   ' },
          { display_name: 'A'.repeat(101) },
          { display_name: 'Acme\nInc' },
          { allow_session_duration_choice: 'false' },
        ]) {
          const invalid = await adminRequest(acmeAdmin, {
            method: 'PATCH',
            path: '/api/v1/admin/realms/acme/settings',
            body,
          });
          assert.equal(invalid.status, 400);
          assert.equal(invalid.json.error.code, 'invalid_request');
        }

        const stored = withRealmDatabase(env, 'acme', (database) =>
          database
            .prepare('SELECT slug, status FROM realm_settings WHERE id = 1')
            .get()
        );
        assert.equal(stored.slug, 'acme');
        assert.equal(stored.status, 'active');
      } finally {
        if (original) {
          await adminRequest(systemAdmin, {
            method: 'PATCH',
            path: '/api/v1/admin/realms/acme/settings',
            body: {
              display_name: original.display_name,
              allow_session_duration_choice: original.allow_session_duration_choice,
            },
          });
        }
      }
    });
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
