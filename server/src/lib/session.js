import crypto from 'node:crypto';
import { parseCookie, stringifySetCookie } from 'cookie';
import { findUserById, getMembership, getUserRoles } from './users.js';

export const SHORT_SESSION_TTL = 12 * 60 * 60;
export const LONG_SESSION_TTL = 7 * 24 * 60 * 60;
export const SESSION_COOKIE = 'auth_session';
const TOUCH_INTERVAL_MS = 60 * 1000;

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

export function setSessionCookie(res, req, token, ttl) {
  appendSetCookie(
    res,
    stringifySetCookie({
      name: SESSION_COOKIE,
      value: token,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ttl,
      secure: isSecureRequest(req),
    })
  );
}

export function clearSessionCookie(res, req) {
  appendSetCookie(
    res,
    stringifySetCookie({
      name: SESSION_COOKIE,
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
      secure: isSecureRequest(req),
    })
  );
}

export function requestToken(req) {
  const cookies = parseCookie(req.headers.cookie || '');
  return cookies[SESSION_COOKIE] || null;
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

function scopeForContext(context) {
  if (context.mode === 'canonical') {
    return { scopeType: 'global', realmId: null, clientId: null };
  }
  if (context.mode === 'realm') {
    return { scopeType: 'realm', realmId: context.realm.id, clientId: null };
  }
  return {
    scopeType: 'client',
    realmId: context.realm.id,
    clientId: context.clientId,
  };
}

function scopeMatches(session, context) {
  if (session.scope_host !== context.host) return false;
  if (context.mode === 'canonical') return session.scope_type === 'global';
  if (context.mode === 'realm') {
    return session.scope_type === 'realm' && session.realm_id === context.realm.id;
  }
  return (
    session.scope_type === 'client' &&
    session.realm_id === context.realm.id &&
    session.client_id === context.clientId
  );
}

async function findGroupByToken(systemDb, token) {
  if (!token) return null;
  return systemDb.get(
    `SELECT id, host, active_session_id, created_at, last_seen_at
       FROM session_groups
      WHERE id = {id}`,
    { id: hashToken(token) }
  );
}

async function findActiveSession(systemDb, group) {
  if (!group?.active_session_id) return null;
  return systemDb.get(
    `SELECT id, public_id, group_id, user_id, scope_type, scope_host, realm_id,
            client_id, ttl, auth_time, created_at, expires_at, last_seen_at,
            user_agent, ip
       FROM sessions
      WHERE id = {id} AND group_id = {groupId}`,
    { id: group.active_session_id, groupId: group.id }
  );
}

export async function getSessionByToken(systemDb, token, now = Date.now()) {
  const group = await findGroupByToken(systemDb, token);
  if (!group) return null;
  const session = await findActiveSession(systemDb, group);
  if (!session || session.expires_at <= now) return null;
  return { group, session };
}

async function deleteGroup(systemDb, groupId) {
  await systemDb.run('DELETE FROM session_groups WHERE id = {id}', { id: groupId });
}

async function nextActiveSession(systemDb, groupId, now) {
  return systemDb.get(
    `SELECT id
       FROM sessions
      WHERE group_id = {groupId} AND expires_at > {now}
      ORDER BY created_at DESC
      LIMIT 1`,
    { groupId, now }
  );
}

export async function purgeExpiredSessions(systemDb, now = Date.now()) {
  await systemDb.transaction(async (tx) => {
    await tx.run('DELETE FROM sessions WHERE expires_at <= {now}', { now });
    await tx.run(
      'DELETE FROM session_groups WHERE id NOT IN (SELECT group_id FROM sessions)'
    );
  });
}

export async function createHostSession(
  systemDb,
  { context, token = null, userId, ttl, userAgent = null, ip = null },
  now = Date.now()
) {
  const scope = scopeForContext(context);

  return systemDb.transaction(async (tx) => {
    let group = await findGroupByToken(tx, token);

    if (group && group.host === context.host) {
      const existing = await tx.get(
        `SELECT id, public_id, group_id, user_id, scope_type, scope_host, realm_id,
                client_id, ttl, auth_time, created_at, expires_at, last_seen_at,
                user_agent, ip
           FROM sessions
          WHERE group_id = {groupId} AND user_id = {userId}`,
        { groupId: group.id, userId }
      );

      if (
        existing &&
        existing.expires_at > now &&
        existing.scope_type === scope.scopeType &&
        existing.scope_host === context.host &&
        existing.realm_id === scope.realmId &&
        existing.client_id === scope.clientId
      ) {
        const sessionTtl = Math.max(existing.ttl, ttl);
        const expiresAt = Math.max(existing.expires_at, now + sessionTtl * 1000);
        await tx.run(
          `UPDATE sessions
              SET ttl = {ttl}, expires_at = {expiresAt}, last_seen_at = {now},
                  user_agent = {userAgent}, ip = {ip}
            WHERE id = {id}`,
          { ttl: sessionTtl, expiresAt, now, userAgent, ip, id: existing.id }
        );
        await tx.run(
          `UPDATE session_groups
              SET active_session_id = {sessionId}, last_seen_at = {now}
            WHERE id = {groupId}`,
          { sessionId: existing.id, now, groupId: group.id }
        );
        return {
          token,
          group: { ...group, active_session_id: existing.id, last_seen_at: now },
          session: {
            ...existing,
            ttl: sessionTtl,
            expires_at: expiresAt,
            last_seen_at: now,
            user_agent: userAgent,
            ip,
          },
        };
      }

      await deleteGroup(tx, group.id);
      group = null;
    }

    const nextToken = crypto.randomBytes(32).toString('base64url');
    const groupId = hashToken(nextToken);
    const sessionId = crypto.randomUUID();
    const publicId = crypto.randomUUID();
    const createdAt = now;
    const expiresAt = now + ttl * 1000;
    const authTime = Math.floor(now / 1000);

    await tx.run(
      `INSERT INTO session_groups
        (id, host, active_session_id, created_at, last_seen_at)
       VALUES
        ({id}, {host}, {activeSessionId}, {createdAt}, {lastSeenAt})`,
      {
        id: groupId,
        host: context.host,
        activeSessionId: sessionId,
        createdAt,
        lastSeenAt: now,
      }
    );

    await tx.run(
      `INSERT INTO sessions
        (id, public_id, group_id, user_id, scope_type, scope_host, realm_id,
         client_id, ttl, auth_time, created_at, expires_at, last_seen_at,
         user_agent, ip)
       VALUES
        ({id}, {publicId}, {groupId}, {userId}, {scopeType}, {scopeHost}, {realmId},
         {clientId}, {ttl}, {authTime}, {createdAt}, {expiresAt}, {lastSeenAt},
         {userAgent}, {ip})`,
      {
        id: sessionId,
        publicId,
        groupId,
        userId,
        scopeType: scope.scopeType,
        scopeHost: context.host,
        realmId: scope.realmId,
        clientId: scope.clientId,
        ttl,
        authTime,
        createdAt,
        expiresAt,
        lastSeenAt: now,
        userAgent,
        ip,
      }
    );

    const session = {
      id: sessionId,
      public_id: publicId,
      group_id: groupId,
      user_id: userId,
      scope_type: scope.scopeType,
      scope_host: context.host,
      realm_id: scope.realmId,
      client_id: scope.clientId,
      ttl,
      auth_time: authTime,
      created_at: createdAt,
      expires_at: expiresAt,
      last_seen_at: now,
      user_agent: userAgent,
      ip,
    };

    return {
      token: nextToken,
      group: {
        id: groupId,
        host: context.host,
        active_session_id: sessionId,
        created_at: createdAt,
        last_seen_at: now,
      },
      session,
    };
  });
}

export async function authenticateRequest({
  systemDb,
  realmDb = null,
  req,
  res,
  context,
  now = Date.now(),
}) {
  const token = requestToken(req);
  if (!token) return null;

  const group = await findGroupByToken(systemDb, token);
  if (!group || group.host !== context.host) {
    clearSessionCookie(res, req);
    return null;
  }

  const session = await findActiveSession(systemDb, group);
  if (!session || session.expires_at <= now) {
    if (session) {
      await systemDb.run('DELETE FROM sessions WHERE id = {id}', { id: session.id });
    }
    const next = await nextActiveSession(systemDb, group.id, now);
    if (next) {
      await systemDb.run(
        'UPDATE session_groups SET active_session_id = {sessionId} WHERE id = {id}',
        { sessionId: next.id, id: group.id }
      );
    } else {
      await deleteGroup(systemDb, group.id);
      clearSessionCookie(res, req);
    }
    return null;
  }

  if (!scopeMatches(session, context)) {
    clearSessionCookie(res, req);
    return null;
  }

  const user = await findUserById(systemDb, session.user_id);
  if (!user || user.status !== 'active') {
    await deleteGroup(systemDb, group.id);
    clearSessionCookie(res, req);
    return null;
  }

  const membership = realmDb ? await getMembership(realmDb, user.id) : null;
  const roles = realmDb ? await getUserRoles(realmDb, user.id) : [];

  if (now - session.last_seen_at >= TOUCH_INTERVAL_MS) {
    const expiresAt = now + session.ttl * 1000;
    await systemDb.transaction(async (tx) => {
      await tx.run(
        `UPDATE sessions
            SET last_seen_at = {now}, expires_at = {expiresAt}
          WHERE id = {id}`,
        { now, expiresAt, id: session.id }
      );
      await tx.run(
        'UPDATE session_groups SET last_seen_at = {now} WHERE id = {id}',
        { now, id: group.id }
      );
    });
    session.last_seen_at = now;
    session.expires_at = expiresAt;
    setSessionCookie(res, req, token, session.ttl);
  }

  return { group, session, user, membership, roles };
}

export async function destroySession(systemDb, token) {
  if (!token) return { groupDeleted: true };

  return systemDb.transaction(async (tx) => {
    const group = await findGroupByToken(tx, token);
    if (!group) return { groupDeleted: true };

    const session = await findActiveSession(tx, group);
    if (session) {
      await tx.run('DELETE FROM sessions WHERE id = {id}', { id: session.id });
    }

    const next = await nextActiveSession(tx, group.id, Date.now());
    if (next) {
      await tx.run(
        'UPDATE session_groups SET active_session_id = {sessionId} WHERE id = {id}',
        { sessionId: next.id, id: group.id }
      );
      return { groupDeleted: false };
    }

    await deleteGroup(tx, group.id);
    return { groupDeleted: true };
  });
}

export async function bindSessionRealm(systemDb, sessionId, realmId, now = Date.now()) {
  const existing = await systemDb.get(
    `SELECT session_id, realm_id, revoked_at
       FROM session_realms
      WHERE session_id = {sessionId} AND realm_id = {realmId}`,
    { sessionId, realmId }
  );

  if (existing) {
    if (!existing.revoked_at) {
      await systemDb.run(
        `UPDATE session_realms
            SET last_seen_at = {now}
          WHERE session_id = {sessionId} AND realm_id = {realmId}`,
        { now, sessionId, realmId }
      );
    }
    return;
  }

  await systemDb.run(
    `INSERT INTO session_realms
      (session_id, realm_id, created_at, last_seen_at, revoked_at, revoked_by)
     VALUES
      ({sessionId}, {realmId}, {now}, {now}, NULL, NULL)`,
    { sessionId, realmId, now }
  );
}
