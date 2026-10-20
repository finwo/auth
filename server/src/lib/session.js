import crypto from 'node:crypto';
import { parseCookie, stringifySetCookie } from 'cookie';
import { findUserById, getMembership, getUserRoles } from './users.js';

export const SHORT_SESSION_TTL = 12 * 60 * 60;
export const LONG_SESSION_TTL = 7 * 24 * 60 * 60;
const TOUCH_INTERVAL_MS = 60 * 1000;

export function sessionCookieName(realm) {
  return `auth_session_${realm.slug}`;
}

function isSecureRequest(req) {
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

export function setSessionCookie(res, req, realm, token, ttl) {
  appendSetCookie(
    res,
    stringifySetCookie({
      name: sessionCookieName(realm),
      value: token,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ttl,
      secure: isSecureRequest(req),
    })
  );
}

export function clearSessionCookie(res, req, realm) {
  appendSetCookie(
    res,
    stringifySetCookie({
      name: sessionCookieName(realm),
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
      secure: isSecureRequest(req),
    })
  );
}

export function requestToken(req, realm) {
  const cookies = parseCookie(req.headers.cookie || '');
  return cookies[sessionCookieName(realm)] || null;
}

export function requestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || req.socket?.remoteAddress || null;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function purgeExpiredSessions(db, now = Date.now()) {
  await db.run('DELETE FROM sessions WHERE expires_at <= {now}', { now });
}

export async function createSession(db, { userId, ttl, userAgent = null, ip = null }, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  const session = {
    id: hashToken(token),
    user_id: userId,
    ttl,
    created_at: now,
    expires_at: now + ttl * 1000,
    last_seen_at: now,
    user_agent: userAgent,
    ip,
  };

  await db.run(
    `INSERT INTO sessions
      (id, user_id, ttl, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES
      ({id}, {userId}, {ttl}, {createdAt}, {expiresAt}, {lastSeenAt}, {userAgent}, {ip})`,
    {
      id: session.id,
      userId: session.user_id,
      ttl: session.ttl,
      createdAt: session.created_at,
      expiresAt: session.expires_at,
      lastSeenAt: session.last_seen_at,
      userAgent: session.user_agent,
      ip: session.ip,
    }
  );

  return { token, session };
}

export async function getSessionByToken(db, token, now = Date.now()) {
  if (!token) return null;
  const session = await db.get(
    `SELECT id, user_id, ttl, created_at, expires_at, last_seen_at, user_agent, ip
       FROM sessions
      WHERE id = {id}`,
    { id: hashToken(token) }
  );
  if (!session) return null;
  if (session.expires_at <= now) {
    await db.run('DELETE FROM sessions WHERE id = {id}', { id: session.id });
    return null;
  }
  return session;
}

export async function destroySession(db, token) {
  if (!token) return;
  await db.run('DELETE FROM sessions WHERE id = {id}', { id: hashToken(token) });
}

export async function authenticateRequest({
  systemDb,
  realmDb,
  req,
  res,
  realm,
  now = Date.now(),
}) {
  const token = requestToken(req, realm);
  if (!token) return null;

  const session = await getSessionByToken(realmDb, token, now);
  if (!session) return null;

  const user = await findUserById(systemDb, session.user_id);
  if (!user || user.status !== 'active') {
    await destroySession(realmDb, token);
    clearSessionCookie(res, req, realm);
    return null;
  }

  const membership = await getMembership(realmDb, user.id);
  if (!membership || membership.status !== 'active') {
    await destroySession(realmDb, token);
    clearSessionCookie(res, req, realm);
    return null;
  }

  if (now - session.last_seen_at >= TOUCH_INTERVAL_MS) {
    const expiresAt = now + session.ttl * 1000;
    await realmDb.run(
      `UPDATE sessions
          SET last_seen_at = {now}, expires_at = {expiresAt}
        WHERE id = {id}`,
      { now, expiresAt, id: session.id }
    );
    session.last_seen_at = now;
    session.expires_at = expiresAt;
    setSessionCookie(res, req, realm, token, session.ttl);
  }

  const roles = await getUserRoles(realmDb, user.id);
  return { session, user, membership, roles };
}
