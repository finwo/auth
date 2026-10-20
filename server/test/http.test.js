import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
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

test('HTTP realm, login, OIDC and logout flows', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-http-'));
  const port = await freePort();
  const publicUrl = `http://identity.test:${port}`;
  const env = {
    AUTH_DATABASE_PATH: path.join(dir, 'system.sqlite'),
    AUTH_REALMS_PATH: path.join(dir, 'realms'),
    AUTH_PORT: String(port),
    AUTH_PUBLIC_URL: publicUrl,
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
        path: '/oidc/acme/internal-app/openid-configuration',
      });
      assert.equal(canonical.status, 200);
      assert.equal(canonical.json.client_id, 'internal-app');
      assert.equal(canonical.json.issuer, `${publicUrl}/oidc/acme`);
      assert.equal(
        canonical.json.authorization_endpoint,
        `${origin('identity.test')}/oidc/acme/internal-app/authorize`
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

    await t.test('virtual clients are discoverable', async () => {
      const admin = await acme({ path: '/oidc/admin/openid-configuration' });
      assert.equal(admin.status, 200);
      assert.equal(admin.json.virtual, true);
      assert.equal(admin.json.access_mode, 'admin');

      const account = await acme({ path: '/oidc/account/openid-configuration' });
      assert.equal(account.status, 200);
      assert.equal(account.json.virtual, true);
      assert.equal(account.json.access_mode, 'public');
    });

    await t.test('identifier resolution selects password or upstream OIDC', async () => {
      const password = await acme({
        method: 'POST',
        path: '/api/v1/login/resolve',
        body: { identifier: 'alice@acme.test' },
      });
      assert.equal(password.status, 200);
      assert.equal(password.json.next, 'password');

      const upstream = await acme({
        method: 'POST',
        path: '/api/v1/login/resolve',
        body: { identifier: 'someone@sso.acme.test' },
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

      const cookie = mergeCookies('', response);
      const session = await acme({ path: '/api/v1/session', cookie });
      assert.equal(session.status, 200);
      assert.equal(session.json.user.username, 'alice');
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
        body: { client_id: 'members-app', identifier: 'contractor@personal.test', password: 'demo' },
      });
      assert.equal(denied.status, 401);

      const allowed = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'public-app', identifier: 'guest@personal.test', password: 'demo' },
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
        body: { client_id: 'members-app', identifier: 'contractor@personal.test', password: 'demo' },
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

      const second = await app({ path: authorizePath, cookie: jar });
      assert.equal(second.status, 302);
      const redirected = locationQuery(second);
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

    await t.test('public clients allow non-members through authorize', async () => {
      const { verifier, challenge } = pkce();
      const redirectUri = `${origin('public.localhost')}/callback`;
      const authorizePath =
        `/oidc/public-app/authorize?response_type=code&client_id=public-app` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email` +
        `&state=state-2&code_challenge=${challenge}&code_challenge_method=S256`;

      const first = await acme({ path: authorizePath });
      assert.equal(first.status, 302);
      let jar = mergeCookies('', first);

      const login = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'public-app', identifier: 'contractor@personal.test', password: 'demo' },
        cookie: jar,
      });
      assert.equal(login.status, 200);
      assert.equal(login.json.pending_auth_request, true);
      jar = mergeCookies(jar, login);

      const second = await acme({ path: authorizePath, cookie: jar });
      assert.equal(second.status, 302);
      const code = locationQuery(second).searchParams.get('code');
      assert.ok(code);

      const tokenResponse = await acme({
        method: 'POST',
        path: '/oidc/public-app/token',
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: 'public-app',
          code_verifier: verifier,
        },
      });
      assert.equal(tokenResponse.status, 200);
    });

    await t.test('system admins can use the admin virtual client', async () => {
      const redirectUri = `${origin('acme.localhost')}/oidc/admin/callback`;
      const { verifier, challenge } = pkce();
      const authorizePath =
        `/oidc/admin/authorize?response_type=code&client_id=admin` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20profile` +
        `&state=state-3&code_challenge=${challenge}&code_challenge_method=S256`;

      const first = await acme({ path: authorizePath });
      assert.equal(first.status, 302);
      let jar = mergeCookies('', first);

      const login = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'admin', identifier: 'admin@system.test', password: 'demo' },
        cookie: jar,
      });
      assert.equal(login.status, 200);
      jar = mergeCookies(jar, login);

      const second = await acme({ path: authorizePath, cookie: jar });
      assert.equal(second.status, 302);
      const code = locationQuery(second).searchParams.get('code');
      assert.ok(code);

      const tokenResponse = await acme({
        method: 'POST',
        path: '/oidc/admin/token',
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: 'admin',
          code_verifier: verifier,
        },
      });
      assert.equal(tokenResponse.status, 200);
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
      const second = await acme({ path: authorizePath, cookie: jar });
      const code = locationQuery(second).searchParams.get('code');

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

    await t.test('logout removes only the current realm session', async () => {
      const acmeLogin = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'internal-app', identifier: 'alice@acme.test', password: 'demo' },
      });
      const acmeCookie = mergeCookies('', acmeLogin);

      const globexLogin = await globex({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { client_id: 'members-app', identifier: 'contractor@personal.test', password: 'demo' },
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
