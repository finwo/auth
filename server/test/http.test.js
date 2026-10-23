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
import { gzipSync } from 'node:zlib';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { packTar } from 'modern-tar';

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
  {
    method = 'GET',
    path: requestPath = '/',
    host,
    body,
    form,
    raw,
    contentType,
    cookie,
    bearer,
    headers: extraHeaders = {},
  } = {}
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
    } else if (raw !== undefined) {
      payload = Buffer.from(raw);
      headers['content-type'] = contentType || 'application/gzip';
      headers['content-length'] = payload.byteLength;
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
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
            buffer: Buffer.concat(chunks),
          });
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

async function templateArchive(files) {
  const entries = files.map(({ name, body = '' }) => ({
    header: { name, size: Buffer.byteLength(body) },
    body,
  }));
  return gzipSync(await packTar(entries));
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, body = '' } of files) {
    const nameBuffer = Buffer.from(name);
    const source = Buffer.from(body);
    const checksum = crc32(source);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(source.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, source);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(source.length, 20);
    header.writeUInt32LE(source.length, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuffer);

    offset += local.length + nameBuffer.length + source.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}

async function distributionPackage(manifest, files) {
  const manifestBody = JSON.stringify(manifest, null, 2);
  const entries = [
    { header: { name: 'manifest.json', size: Buffer.byteLength(manifestBody) }, body: manifestBody },
    ...files.map(({ name, body }) => ({
      header: { name, size: body.byteLength },
      body,
    })),
  ];
  return gzipSync(await packTar(entries));
}

async function multipartUpload(fields, file) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(name, String(value));
  }
  form.append('file', new Blob([file.body], { type: file.type }), file.name);
  const request = new Request('http://localhost/upload', { method: 'POST', body: form });
  return {
    raw: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get('content-type'),
  };
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
    AUTH_PACKAGES_PATH: path.join(dir, 'packages'),
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
      assert.match(admin.text, /Administration/);

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

    await t.test('app config provides template layers and archives', async (t) => {
      const config = await identity({ path: '/app/admin/config.json' });
      if (config.status === 503) {
        t.skip('template build is not available');
        return;
      }
      assert.equal(config.status, 200);
      assert.equal(config.json.auth_url, publicUrl);
      assert.equal(
        config.json.openid_configuration,
        `${publicUrl}/oidc/admin/openid-configuration`
      );
      assert.equal(config.json.templateLayers.length, 1);
      assert.match(config.json.templateLayers[0].digest, /^[a-f0-9]{64}$/);
      assert.match(
        config.json.templateLayers[0].url,
        /^\/app\/admin\/static\/[a-f0-9]{64}\.tar\.gz$/
      );

      const archive = await identity({ path: config.json.templateLayers[0].url });
      assert.equal(archive.status, 200);
      assert.match(archive.headers['content-type'], /application\/gzip/);
      assert.match(archive.headers['cache-control'], /immutable/);

      const login = await acme({
        path: '/app/login/config.json?client_id=acme-public-app',
      });
      assert.equal(login.status, 200);
      assert.equal(
        login.json.openid_configuration,
        `${origin('acme.localhost')}/oidc/acme-public-app/openid-configuration`
      );

      const client = await app({ path: '/app/login/config.json' });
      assert.equal(client.status, 200);
      assert.equal(client.json.openid_configuration, `${origin('app.acme.localhost')}/oidc/openid-configuration`);

      const adminRealm = await acme({ path: '/app/admin/config.json' });
      assert.equal(adminRealm.status, 404);
    });

    await t.test('system admins manage distribution packages', async (t) => {
      const available = await identity({ path: '/app/admin/config.json' });
      if (available.status !== 200) {
        t.skip('template build is not available');
        return;
      }

      const admin = await adminToken();
      const realmAdmin = await adminToken('it@acme.test');
      const created = [];

      try {
        const manifestBody = JSON.stringify({
          type: 'dashboard-v1',
          author: { name: 'Acme Design', email: 'design@acme.test' },
          package: { name: 'Acme dashboard', version: '1.0.0' },
        });
        const tarPackage = await distributionPackage(
          JSON.parse(manifestBody),
          [{ name: 'theme.css', body: Buffer.from('.dashboard { color: #25a; }') }]
        );
        const zipPackage = zipArchive([
          { name: 'manifest.json', body: manifestBody },
          { name: 'theme.css', body: '.dashboard { color: #333; }' },
        ]);

        const missing = await identity({ path: '/api/v1/admin/packages' });
        assert.equal(missing.status, 401);

        const forbidden = await identity({
          path: '/api/v1/admin/packages',
          bearer: realmAdmin.access_token,
        });
        assert.equal(forbidden.status, 403);

        const wrongType = await identity({
          method: 'POST',
          path: '/api/v1/admin/packages',
          raw: tarPackage,
          contentType: 'text/plain',
          bearer: admin.access_token,
        });
        assert.equal(wrongType.status, 415);

        const bare = await identity({
          method: 'POST',
          path: '/api/v1/admin/packages',
          raw: await templateArchive([{ name: 'login/identifier.hbs', body: 'x' }]),
          bearer: admin.access_token,
        });
        assert.equal(bare.status, 400);
        assert.equal(bare.json.error.code, 'invalid_package');

        const uploadTar = await identity({
          method: 'POST',
          path: '/api/v1/admin/packages',
          raw: tarPackage,
          bearer: admin.access_token,
        });
        assert.equal(uploadTar.status, 201);
        const tar = uploadTar.json.package;
        created.push(tar.id);
        assert.equal(tar.type, 'dashboard-v1');
        assert.equal(tar.name, 'Acme dashboard');
        assert.equal(tar.version, '1.0.0');
        assert.equal(tar.author_name, 'Acme Design');
        assert.equal(tar.author_email, 'design@acme.test');
        assert.equal(tar.template, null);

        const uploadZip = await identity({
          method: 'POST',
          path: '/api/v1/admin/packages',
          raw: zipPackage,
          contentType: 'application/zip',
          bearer: admin.access_token,
        });
        assert.equal(uploadZip.status, 201);
        const zipped = uploadZip.json.package;
        created.push(zipped.id);
        assert.equal(zipped.type, 'dashboard-v1');
        assert.equal(zipped.template, null);

        const duplicate = await identity({
          method: 'POST',
          path: '/api/v1/admin/packages',
          raw: tarPackage,
          bearer: admin.access_token,
        });
        assert.equal(duplicate.status, 409);
        assert.equal(duplicate.json.error.code, 'package_exists');

        const list = await identity({
          path: '/api/v1/admin/packages',
          bearer: admin.access_token,
        });
        assert.equal(list.status, 200);
        assert.deepEqual(
          list.json.packages.map((item) => item.id).sort(),
          [tar.id, zipped.id].sort()
        );

        const remove = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/packages/${zipped.id}`,
          bearer: admin.access_token,
        });
        assert.equal(remove.status, 200);
        created.splice(created.indexOf(zipped.id), 1);
      } finally {
        for (const id of created) {
          await identity({
            method: 'DELETE',
            path: `/api/v1/admin/packages/${id}`,
            bearer: admin.access_token,
          });
        }
      }
    });

    await t.test('system admins manage realm template packages', async (t) => {
      const available = await identity({ path: '/app/admin/config.json' });
      if (available.status !== 200) {
        t.skip('template build is not available');
        return;
      }

      const admin = await adminToken();
      const realmAdmin = await adminToken('it@acme.test');
      const created = [];

      try {
        const firstArchive = await templateArchive([
          { name: 'login/identifier.hbs', body: '<h1>Acme sign in</h1>' },
        ]);
        const secondArchive = await templateArchive([
          { name: 'login/password.hbs', body: '<h1>Acme password</h1>' },
          { name: 'style/overlay.css', body: '.auth-card { border: 0; }' },
        ]);
        const thirdArchive = await templateArchive([
          { name: 'login/identifier.hbs', body: '<h1>Bare sign in</h1>' },
        ]);

        const firstManifest = {
          type: 'template-v1',
          author: { name: 'Acme Design', email: 'design@acme.test' },
          template: {
            name: 'Acme theme',
            version: '1.0.0',
            package: '/theme.tar.gz',
          },
        };
        const secondManifest = {
          type: 'template-v1',
          author: { name: 'Acme Extra' },
          template: {
            name: 'Acme extra',
            version: '2.0.0',
            package: '/extra.tar.gz',
          },
        };

        const firstPackage = await distributionPackage(firstManifest, [
          { name: 'theme.tar.gz', body: firstArchive },
        ]);
        const secondPackage = zipArchive([
          { name: 'manifest.json', body: JSON.stringify(secondManifest, null, 2) },
          { name: 'extra.tar.gz', body: secondArchive },
        ]);
        const genericPackage = await distributionPackage(
          {
            type: 'dashboard-v1',
            author: { name: 'Acme Design' },
            package: { name: 'Dashboard', version: '1.0.0' },
          },
          [{ name: 'theme.css', body: Buffer.from('.x { color: red; }') }]
        );

        const uploadFirst = await identity({
          method: 'POST',
          path: '/api/v1/admin/packages',
          raw: firstPackage,
          bearer: admin.access_token,
        });
        assert.equal(uploadFirst.status, 201);
        const first = uploadFirst.json.package;
        created.push(first.id);
        assert.equal(first.name, 'Acme theme');
        assert.equal(first.version, '1.0.0');
        assert.equal(first.author_name, 'Acme Design');
        assert.equal(first.template.label, 'Acme theme 1.0.0');
        assert.equal(
          first.template.digest,
          crypto.createHash('sha256').update(firstArchive).digest('hex')
        );
        assert.equal(first.template.path, 'theme.tar.gz');

        const uploadSecond = await identity({
          method: 'POST',
          path: '/api/v1/admin/templates',
          raw: secondPackage,
          contentType: 'application/zip',
          bearer: admin.access_token,
        });
        assert.equal(uploadSecond.status, 201);
        const second = uploadSecond.json.template;
        created.push(second.id);
        assert.equal(second.name, 'Acme extra');
        assert.equal(second.template.label, 'Acme extra 2.0.0');
        assert.equal(second.template.path, 'extra.tar.gz');

        const bareUpload = await multipartUpload(
          {
            name: 'Bare theme',
            version: '3.0.0',
            author_name: 'Bare Author',
          },
          {
            name: 'bare.tar.gz',
            body: thirdArchive,
            type: 'application/gzip',
          }
        );
        const uploadThird = await identity({
          method: 'POST',
          path: '/api/v1/admin/templates',
          raw: bareUpload.raw,
          contentType: bareUpload.contentType,
          bearer: admin.access_token,
        });
        assert.equal(uploadThird.status, 201);
        const third = uploadThird.json.template;
        created.push(third.id);
        assert.equal(third.name, 'Bare theme');
        assert.equal(third.template.label, 'Bare theme 3.0.0');

        const missingMetadata = await multipartUpload(
          {},
          {
            name: 'bare.tar.gz',
            body: thirdArchive,
            type: 'application/gzip',
          }
        );
        const noMetadata = await identity({
          method: 'POST',
          path: '/api/v1/admin/templates',
          raw: missingMetadata.raw,
          contentType: missingMetadata.contentType,
          bearer: admin.access_token,
        });
        assert.equal(noMetadata.status, 400);
        assert.equal(noMetadata.json.error.code, 'invalid_request');

        const duplicateBare = await multipartUpload(
          {
            name: 'Duplicate bare',
            version: '3.0.0',
            author_name: 'Bare Author',
          },
          {
            name: 'bare.tar.gz',
            body: thirdArchive,
            type: 'application/gzip',
          }
        );
        const duplicate = await identity({
          method: 'POST',
          path: '/api/v1/admin/templates',
          raw: duplicateBare.raw,
          contentType: duplicateBare.contentType,
          bearer: admin.access_token,
        });
        assert.equal(duplicate.status, 409);
        assert.equal(duplicate.json.error.code, 'template_exists');

        const generic = await identity({
          method: 'POST',
          path: '/api/v1/admin/templates',
          raw: genericPackage,
          bearer: admin.access_token,
        });
        assert.equal(generic.status, 422);
        assert.equal(generic.json.error.code, 'not_template_package');

        const templates = await identity({
          path: '/api/v1/admin/templates',
          bearer: admin.access_token,
        });
        assert.equal(templates.status, 200);
        assert.deepEqual(
          templates.json.templates.map((item) => item.id).sort(),
          [first.id, second.id, third.id].sort()
        );

        const systemAssign = await identity({
          method: 'PUT',
          path: '/api/v1/admin/system/templates',
          body: { package_ids: [third.id] },
          bearer: admin.access_token,
        });
        assert.equal(systemAssign.status, 200);
        assert.deepEqual(
          systemAssign.json.layers.map((layer) => layer.id),
          [third.id]
        );

        const systemConfig = await identity({ path: '/app/admin/config.json' });
        assert.deepEqual(
          systemConfig.json.templateLayers.slice(1).map((layer) => layer.digest),
          [third.template.digest]
        );

        const systemClear = await identity({
          method: 'PUT',
          path: '/api/v1/admin/system/templates',
          body: { package_ids: [] },
          bearer: admin.access_token,
        });
        assert.equal(systemClear.status, 200);

        const assign = await identity({
          method: 'PUT',
          path: '/api/v1/admin/realms/acme/templates',
          body: { package_ids: [second.id, first.id, third.id] },
          bearer: admin.access_token,
        });
        assert.equal(assign.status, 200);
        assert.deepEqual(
          assign.json.layers.map((layer) => [layer.id, layer.position]),
          [
            [second.id, 0],
            [first.id, 1],
            [third.id, 2],
          ]
        );

        const assignment = await identity({
          path: '/api/v1/admin/realms/acme/templates',
          bearer: admin.access_token,
        });
        assert.equal(assignment.status, 200);
        assert.deepEqual(
          assignment.json.layers.map((layer) => [layer.id, layer.position]),
          [
            [second.id, 0],
            [first.id, 1],
            [third.id, 2],
          ]
        );

        const packages = await identity({
          path: '/api/v1/admin/packages',
          bearer: admin.access_token,
        });
        const assignedPackage = packages.json.packages.find((item) => item.id === second.id);
        assert.equal(assignedPackage.template_count, 1);

        const forbiddenAssignment = await identity({
          path: '/api/v1/admin/realms/acme/templates',
          bearer: realmAdmin.access_token,
        });
        assert.equal(forbiddenAssignment.status, 403);

        const realmConfig = await acme({
          path: '/app/login/config.json?client_id=acme-public-app',
        });
        assert.equal(realmConfig.status, 200);
        assert.deepEqual(
          realmConfig.json.templateLayers.slice(1).map((layer) => layer.digest),
          [second.template.digest, first.template.digest, third.template.digest]
        );

        const canonicalConfig = await identity({ path: '/app/admin/config.json' });
        assert.equal(canonicalConfig.status, 200);
        assert.equal(canonicalConfig.json.templateLayers.length, 1);

        const clientConfig = await app({ path: '/app/login/config.json' });
        assert.equal(clientConfig.status, 200);
        assert.deepEqual(
          clientConfig.json.templateLayers.slice(1).map((layer) => layer.digest),
          [second.template.digest, first.template.digest, third.template.digest]
        );

        const firstLayer = realmConfig.json.templateLayers.find(
          (layer) => layer.digest === first.template.digest
        );
        const overlayArchive = await acme({ path: firstLayer.url });
        assert.equal(overlayArchive.status, 200);
        assert.match(overlayArchive.headers['content-type'], /application\/gzip/);
        assert.match(overlayArchive.headers['cache-control'], /immutable/);
        assert.deepEqual(overlayArchive.buffer, firstArchive);

        const unknownAssignment = await identity({
          method: 'PUT',
          path: '/api/v1/admin/realms/acme/templates',
          body: { package_ids: [crypto.randomUUID()] },
          bearer: admin.access_token,
        });
        assert.equal(unknownAssignment.status, 400);
        assert.equal(unknownAssignment.json.error.code, 'package_not_template');

        const deleteAssigned = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/templates/${first.id}`,
          bearer: admin.access_token,
        });
        assert.equal(deleteAssigned.status, 409);
        assert.equal(deleteAssigned.json.error.code, 'package_assigned');

        const deleteAssignedPackage = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/packages/${first.id}`,
          bearer: admin.access_token,
        });
        assert.equal(deleteAssignedPackage.status, 409);
        assert.equal(deleteAssignedPackage.json.error.code, 'package_assigned');

        const clear = await identity({
          method: 'PUT',
          path: '/api/v1/admin/realms/acme/templates',
          body: { package_ids: [] },
          bearer: admin.access_token,
        });
        assert.equal(clear.status, 200);
        assert.deepEqual(clear.json.layers, []);

        const deleteFirst = await identity({
          method: 'DELETE',
          path: `/api/v1/admin/templates/${first.id}`,
          bearer: admin.access_token,
        });
        assert.equal(deleteFirst.status, 200);
        created.splice(created.indexOf(first.id), 1);

        const deletedArchive = await acme({ path: firstLayer.url });
        assert.equal(deletedArchive.status, 404);

        for (const template of [second, third]) {
          const removed = await identity({
            method: 'DELETE',
            path: `/api/v1/admin/templates/${template.id}`,
            bearer: admin.access_token,
          });
          assert.equal(removed.status, 200);
          created.splice(created.indexOf(template.id), 1);
        }

        const afterDelete = await acme({
          path: '/app/login/config.json?client_id=acme-public-app',
        });
        assert.equal(afterDelete.json.templateLayers.length, 1);
      } finally {
        await identity({
          method: 'PUT',
          path: '/api/v1/admin/system/templates',
          body: { package_ids: [] },
          bearer: admin.access_token,
        });
        await identity({
          method: 'PUT',
          path: '/api/v1/admin/realms/acme/templates',
          body: { package_ids: [] },
          bearer: admin.access_token,
        });
        for (const id of created) {
          await identity({
            method: 'DELETE',
            path: `/api/v1/admin/packages/${id}`,
            bearer: admin.access_token,
          });
        }
      }
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
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
