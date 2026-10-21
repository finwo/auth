import crypto from 'node:crypto';
import { parseCookie, stringifySetCookie } from 'cookie';

const AUTH_REQUEST_TTL = 10 * 60;
const CODE_TTL = 60;

function authRequestScopeName(scope) {
  if (scope.systemClient) return `system_${scope.clientId}`;
  if (!scope.realm?.slug) throw new Error('auth request scope requires a realm');
  return scope.realm.slug;
}

export function authRequestCookieName(scope) {
  return `auth_request_${authRequestScopeName(scope)}`;
}

function secureRequest(req) {
  if (req.socket?.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', value);
    return;
  }
  const values = Array.isArray(existing) ? existing : [existing];
  res.setHeader('Set-Cookie', [...values, value]);
}

export function setAuthRequestCookie(res, req, scope, id, ttl = AUTH_REQUEST_TTL) {
  appendSetCookie(
    res,
    stringifySetCookie({
      name: authRequestCookieName(scope),
      value: id,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ttl,
      secure: secureRequest(req),
    })
  );
}

export function clearAuthRequestCookie(res, req, scope) {
  appendSetCookie(
    res,
    stringifySetCookie({
      name: authRequestCookieName(scope),
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
      secure: secureRequest(req),
    })
  );
}

export function readAuthRequestId(req, scope) {
  const cookies = parseCookie(req.headers.cookie || '');
  return cookies[authRequestCookieName(scope)] || null;
}

export async function purgeExpired(db, now = Date.now()) {
  await db.run('DELETE FROM auth_requests WHERE expires_at <= {now}', { now });
  await db.run('DELETE FROM authorization_codes WHERE expires_at <= {now}', { now });
}

export async function createAuthRequest(db, data, now = Date.now()) {
  const id = crypto.randomBytes(24).toString('base64url');
  await db.run(
    `INSERT INTO auth_requests
      (id, client_id, redirect_uri, scope, state, nonce, code_challenge,
       code_challenge_method, created_at, expires_at)
     VALUES
      ({id}, {clientId}, {redirectUri}, {scope}, {state}, {nonce}, {codeChallenge},
       {codeChallengeMethod}, {createdAt}, {expiresAt})`,
    {
      id,
      clientId: data.clientId,
      redirectUri: data.redirectUri,
      scope: data.scope,
      state: data.state || null,
      nonce: data.nonce || null,
      codeChallenge: data.codeChallenge || null,
      codeChallengeMethod: data.codeChallengeMethod || null,
      createdAt: now,
      expiresAt: now + AUTH_REQUEST_TTL * 1000,
    }
  );
  return id;
}

export async function getAuthRequest(db, id, now = Date.now()) {
  if (!id) return null;
  const request = await db.get(
    `SELECT id, client_id, redirect_uri, scope, state, nonce, code_challenge,
            code_challenge_method, session_id, user_id, auth_time,
            created_at, expires_at, completed_at
       FROM auth_requests
      WHERE id = {id}`,
    { id }
  );
  if (!request) return null;
  if (request.expires_at <= now) {
    await db.run('DELETE FROM auth_requests WHERE id = {id}', { id });
    return null;
  }
  return request;
}

export async function selectAuthRequestAccount(
  db,
  id,
  { userId, sessionId, authTime }
) {
  if (!id) return;
  await db.run(
    `UPDATE auth_requests
        SET user_id = {userId}, session_id = {sessionId}, auth_time = {authTime}
      WHERE id = {id} AND completed_at IS NULL`,
    { id, userId, sessionId, authTime }
  );
}

export async function clearAuthRequestSelection(db, id) {
  if (!id) return;
  await db.run(
    `UPDATE auth_requests
        SET user_id = NULL, session_id = NULL, auth_time = NULL
      WHERE id = {id} AND completed_at IS NULL`,
    { id }
  );
}

export async function completeAuthRequest(db, id, { userId, sessionId, authTime }, now = Date.now()) {
  await db.run(
    `UPDATE auth_requests
        SET user_id = {userId}, session_id = {sessionId}, auth_time = {authTime}, completed_at = {now}
      WHERE id = {id}`,
    { id, userId, sessionId, authTime, now }
  );
}

export async function deleteAuthRequest(db, id) {
  if (!id) return;
  await db.run('DELETE FROM auth_requests WHERE id = {id}', { id });
}

export async function createAuthorizationCode(db, request, now = Date.now()) {
  const code = crypto.randomBytes(32).toString('base64url');
  const id = crypto.createHash('sha256').update(code).digest('hex');

  await db.run(
    `INSERT INTO authorization_codes
      (id, auth_request_id, client_id, user_id, redirect_uri, scope, nonce,
       code_challenge, code_challenge_method, session_id, auth_time,
       created_at, expires_at)
     VALUES
      ({id}, {authRequestId}, {clientId}, {userId}, {redirectUri}, {scope}, {nonce},
       {codeChallenge}, {codeChallengeMethod}, {sessionId}, {authTime},
       {createdAt}, {expiresAt})`,
    {
      id,
      authRequestId: request.id,
      clientId: request.client_id,
      userId: request.user_id,
      redirectUri: request.redirect_uri,
      scope: request.scope,
      nonce: request.nonce,
      codeChallenge: request.code_challenge,
      codeChallengeMethod: request.code_challenge_method,
      sessionId: request.session_id,
      authTime: request.auth_time,
      createdAt: now,
      expiresAt: now + CODE_TTL * 1000,
    }
  );

  return code;
}

export async function consumeAuthorizationCode(db, code, clientId, now = Date.now()) {
  if (!code) return null;
  const id = crypto.createHash('sha256').update(String(code)).digest('hex');

  return db.transaction(async (tx) => {
    const row = await tx.get(
      `SELECT id, auth_request_id, client_id, user_id, redirect_uri, scope, nonce,
              code_challenge, code_challenge_method, session_id, auth_time,
              expires_at, consumed_at
         FROM authorization_codes
        WHERE id = {id}`,
      { id }
    );
    if (!row || row.consumed_at || row.expires_at <= now || row.client_id !== clientId) {
      return null;
    }
    await tx.run('UPDATE authorization_codes SET consumed_at = {now} WHERE id = {id}', { now, id });
    return row;
  });
}
