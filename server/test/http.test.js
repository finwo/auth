import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function request(port, { method = 'GET', path: requestPath = '/', host, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { host };
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (cookie) headers.cookie = cookie;

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

function sessionCookie(response) {
  const values = response.headers['set-cookie'];
  if (!values || values.length === 0) return null;
  return values[0].split(';')[0];
}

function maxAge(response) {
  const values = response.headers['set-cookie'];
  if (!values || values.length === 0) return null;
  const match = /Max-Age=(\d+)/.exec(values[0]);
  return match ? Number(match[1]) : null;
}

test('HTTP login, session, provider and logout flows', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-http-'));
  const port = await freePort();
  const env = {
    AUTH_DATABASE_PATH: path.join(dir, 'system.sqlite'),
    AUTH_REALMS_PATH: path.join(dir, 'realms'),
    AUTH_PORT: String(port),
  };

  let server = null;
  try {
    await runNode('scripts/seed-demo.js', env);
    server = await startServer(env);

    const acme = (options = {}) =>
      request(port, { host: 'acme.localhost', ...options });
    const globex = (options = {}) =>
      request(port, { host: 'globex.localhost', ...options });

    await t.test('realm metadata is served for a realm hostname', async () => {
      const response = await acme({ path: '/api/v1/realm' });
      assert.equal(response.status, 200);
      assert.equal(response.json.slug, 'acme');
      assert.equal(response.json.allow_session_duration_choice, true);
    });

    await t.test('hostname wins over a conflicting path slug', async () => {
      const response = await acme({ path: '/api/v1/realm?realm=system' });
      assert.equal(response.status, 404);
      assert.equal(response.json.error.code, 'unknown_realm');
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
        body: { identifier: 'alice@acme.test', password: 'demo' },
      });
      assert.equal(response.status, 200);
      assert.equal(response.json.user.username, 'alice');
      assert.equal(maxAge(response), 12 * 60 * 60);

      const cookie = sessionCookie(response);
      const session = await acme({ path: '/api/v1/session', cookie });
      assert.equal(session.status, 200);
      assert.equal(session.json.user.username, 'alice');
      assert.deepEqual(session.json.roles, []);
    });

    await t.test('long sessions are only issued when requested', async () => {
      const response = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { identifier: 'alice@acme.test', password: 'demo', long_session: true },
      });
      assert.equal(response.status, 200);
      assert.equal(maxAge(response), 7 * 24 * 60 * 60);
    });

    await t.test('bad credentials are generic', async () => {
      const response = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { identifier: 'alice@acme.test', password: 'wrong' },
      });
      assert.equal(response.status, 401);
      assert.equal(response.json.error.code, 'invalid_credentials');
    });

    await t.test('membership is required for a realm', async () => {
      const denied = await globex({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { identifier: 'guest@personal.test', password: 'demo' },
      });
      assert.equal(denied.status, 401);

      const allowed = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { identifier: 'guest@personal.test', password: 'demo' },
      });
      assert.equal(allowed.status, 200);
    });

    await t.test('password login is rejected for upstream-mapped domains', async () => {
      const response = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { identifier: 'someone@sso.acme.test', password: 'demo' },
      });
      assert.equal(response.status, 403);
      assert.equal(response.json.error.code, 'provider_required');
    });

    await t.test('guests can hold realm-admin roles', async () => {
      const response = await globex({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { identifier: 'contractor@personal.test', password: 'demo' },
      });
      assert.equal(response.status, 200);
      const session = await globex({
        path: '/api/v1/session',
        cookie: sessionCookie(response),
      });
      assert.equal(session.status, 200);
      assert.ok(session.json.roles.includes('realm-admin'));
    });

    await t.test('logout removes only the current realm session', async () => {
      const acmeLogin = await acme({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { identifier: 'alice@acme.test', password: 'demo' },
      });
      const acmeCookie = sessionCookie(acmeLogin);

      const globexLogin = await globex({
        method: 'POST',
        path: '/api/v1/login/password',
        body: { identifier: 'contractor@personal.test', password: 'demo' },
      });
      const globexCookie = sessionCookie(globexLogin);

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
