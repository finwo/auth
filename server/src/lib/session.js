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

export function sessionMatchesContext(session, context) {
  return scopeMatches(session, context);
}

export async function findActiveSessionById(systemDb, sessionId, now = Date.now()) {
  return systemDb.get(
    `SELECT id, public_id, group_id, user_id, scope_type, scope_host, realm_id,
            client_id, ttl, auth_time, created_at, expires_at, last_seen_at,
            user_agent, ip
       FROM sessions
      WHERE id = {id} AND expires_at > {now}`,
    { id: sessionId, now }
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

async function insertSession(tx, {
  groupId,
  userId,
  scope,
  scopeHost,
  ttl,
  userAgent,
  ip,
  now,
}) {
  const id = crypto.randomUUID();
  const publicId = crypto.randomUUID();
  const expiresAt = now + ttl * 1000;
  const authTime = Math.floor(now / 1000);

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
      id,
      publicId,
      groupId,
      userId,
      scopeType: scope.scopeType,
      scopeHost,
      realmId: scope.realmId,
      clientId: scope.clientId,
      ttl,
      authTime,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
      userAgent,
      ip,
    }
  );

  return {
    id,
    public_id: publicId,
    group_id: groupId,
    user_id: userId,
    scope_type: scope.scopeType,
    scope_host: scopeHost,
    realm_id: scope.realmId,
    client_id: scope.clientId,
    ttl,
    auth_time: authTime,
    created_at: now,
    expires_at: expiresAt,
    last_seen_at: now,
    user_agent: userAgent,
    ip,
  };
}

export async function createHostSession(
  systemDb,
  { context, token = null, userId, ttl, userAgent = null, ip = null },
  now = Date.now()
) {
  const scope = scopeForContext(context);

  return systemDb.transaction(async (tx) => {
    let group = await findGroupByToken(tx, token);
    if (group && group.host !== context.host) group = null;

    if (group) {
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

      if (existing) {
        await tx.run('DELETE FROM sessions WHERE id = {id}', { id: existing.id });
      }

      const session = await insertSession(tx, {
        groupId: group.id,
        userId,
        scope,
        scopeHost: context.host,
        ttl,
        userAgent,
        ip,
        now,
      });
      await tx.run(
        `UPDATE session_groups
            SET active_session_id = {sessionId}, last_seen_at = {now}
          WHERE id = {groupId}`,
        { sessionId: session.id, now, groupId: group.id }
      );

      return {
        token,
        group: { ...group, active_session_id: session.id, last_seen_at: now },
        session,
      };
    }

    const nextToken = crypto.randomBytes(32).toString('base64url');
    const groupId = hashToken(nextToken);
    const createdAt = now;

    await tx.run(
      `INSERT INTO session_groups
        (id, host, active_session_id, created_at, last_seen_at)
       VALUES
        ({id}, {host}, NULL, {createdAt}, {lastSeenAt})`,
      { id: groupId, host: context.host, createdAt, lastSeenAt: now }
    );

    const session = await insertSession(tx, {
      groupId,
      userId,
      scope,
      scopeHost: context.host,
      ttl,
      userAgent,
      ip,
      now,
    });

    await tx.run(
      'UPDATE session_groups SET active_session_id = {sessionId} WHERE id = {id}',
      { sessionId: session.id, id: groupId }
    );

    return {
      token: nextToken,
      group: {
        id: groupId,
        host: context.host,
        active_session_id: session.id,
        created_at: createdAt,
        last_seen_at: now,
      },
      session,
    };
  });
}

export async function listSessionAccounts(systemDb, group, now = Date.now()) {
  if (!group) return [];

  const rows = await systemDb.all(
    `SELECT s.id, s.public_id, s.user_id, s.created_at, s.expires_at,
            u.username, u.display_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.group_id = {groupId}
        AND s.expires_at > {now}
        AND u.status = 'active'
      ORDER BY s.created_at ASC`,
    { groupId: group.id, now }
  );

  return rows.map((row) => ({
    public_id: row.public_id,
    active: row.id === group.active_session_id,
    user: {
      id: row.user_id,
      username: row.username,
      display_name: row.display_name,
    },
    created_at: row.created_at,
    expires_at: row.expires_at,
  }));
}

export async function selectSessionAccount(
  systemDb,
  { token, context, publicId },
  now = Date.now()
) {
  if (!token || !publicId) return null;

  return systemDb.transaction(async (tx) => {
    const group = await findGroupByToken(tx, token);
    if (!group || group.host !== context.host) return null;

    const session = await tx.get(
      `SELECT id, public_id, group_id, user_id, scope_type, scope_host, realm_id,
              client_id, ttl, auth_time, created_at, expires_at, last_seen_at,
              user_agent, ip
         FROM sessions
        WHERE group_id = {groupId} AND public_id = {publicId}`,
      { groupId: group.id, publicId }
    );
    if (!session || session.expires_at <= now || !scopeMatches(session, context)) {
      return null;
    }

    const user = await findUserById(tx, session.user_id);
    if (!user || user.status !== 'active') return null;

    const expiresAt = now + session.ttl * 1000;
    await tx.run(
      `UPDATE sessions
          SET last_seen_at = {now}, expires_at = {expiresAt}
        WHERE id = {id}`,
      { now, expiresAt, id: session.id }
    );
    await tx.run(
      `UPDATE session_groups
          SET active_session_id = {sessionId}, last_seen_at = {now}
        WHERE id = {id}`,
      { sessionId: session.id, now, id: group.id }
    );

    return {
      group: { ...group, active_session_id: session.id, last_seen_at: now },
      session: { ...session, last_seen_at: now, expires_at: expiresAt },
      user,
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
    const groupDeleted = await systemDb.transaction(async (tx) => {
      await tx.run('DELETE FROM sessions WHERE id = {id}', { id: session.id });
      const next = await nextActiveSession(tx, group.id, now);
      if (next) {
        await tx.run(
          'UPDATE session_groups SET active_session_id = {sessionId} WHERE id = {id}',
          { sessionId: next.id, id: group.id }
        );
        return false;
      }
      await deleteGroup(tx, group.id);
      return true;
    });
    if (groupDeleted) clearSessionCookie(res, req);
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

async function removeSession(tx, session, now) {
  const group = await tx.get(
    'SELECT active_session_id FROM session_groups WHERE id = {id}',
    { id: session.group_id }
  );
  await tx.run('DELETE FROM sessions WHERE id = {id}', { id: session.id });
  if (!group) return { groupDeleted: true };
  if (group.active_session_id !== session.id) return { groupDeleted: false };

  const next = await nextActiveSession(tx, session.group_id, now);
  if (next) {
    await tx.run(
      'UPDATE session_groups SET active_session_id = {sessionId} WHERE id = {id}',
      { sessionId: next.id, id: session.group_id }
    );
    return { groupDeleted: false };
  }

  await deleteGroup(tx, session.group_id);
  return { groupDeleted: true };
}

export async function destroySession(systemDb, token) {
  if (!token) return { groupDeleted: true };

  return systemDb.transaction(async (tx) => {
    const group = await findGroupByToken(tx, token);
    if (!group) return { groupDeleted: true };

    const session = await findActiveSession(tx, group);
    if (session) return removeSession(tx, session, Date.now());

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

export async function destroySessionById(systemDb, sessionId, now = Date.now()) {
  return systemDb.transaction(async (tx) => {
    const session = await tx.get(
      'SELECT id, group_id FROM sessions WHERE id = {id}',
      { id: sessionId }
    );
    if (!session) return { deleted: false, groupDeleted: false };

    const result = await removeSession(tx, session, now);
    return { deleted: true, ...result };
  });
}

export async function getSessionRealmBinding(systemDb, sessionId, realmId) {
  return systemDb.get(
    `SELECT session_id, realm_id, created_at, last_seen_at, revoked_at, revoked_by
       FROM session_realms
      WHERE session_id = {sessionId} AND realm_id = {realmId}`,
    { sessionId, realmId }
  );
}

export async function revokeSessionRealm(
  systemDb,
  { sessionId, realmId, revokedBy = null, now = Date.now() }
) {
  return systemDb.transaction(async (tx) => {
    const existing = await getSessionRealmBinding(tx, sessionId, realmId);
    if (existing) {
      if (!existing.revoked_at) {
        await tx.run(
          `UPDATE session_realms
              SET revoked_at = {now}, revoked_by = {revokedBy}
            WHERE session_id = {sessionId} AND realm_id = {realmId}`,
          { now, revokedBy, sessionId, realmId }
        );
        existing.revoked_at = now;
        existing.revoked_by = revokedBy;
      }
      return existing;
    }

    await tx.run(
      `INSERT INTO session_realms
        (session_id, realm_id, created_at, last_seen_at, revoked_at, revoked_by)
       VALUES
        ({sessionId}, {realmId}, {now}, {now}, {now}, {revokedBy})`,
      { sessionId, realmId, now, revokedBy }
    );
    return {
      session_id: sessionId,
      realm_id: realmId,
      created_at: now,
      last_seen_at: now,
      revoked_at: now,
      revoked_by: revokedBy,
    };
  });
}

export async function revokeRealmSessions(
  systemDb,
  { realmId, revokedBy = null, now = Date.now() }
) {
  const result = await systemDb.run(
    `UPDATE session_realms
        SET revoked_at = {now}, revoked_by = {revokedBy}
      WHERE realm_id = {realmId} AND revoked_at IS NULL`,
    { realmId, revokedBy, now }
  );
  return result.changes;
}

export async function reauthenticateSession(
  systemDb,
  { sessionId, realmId, now = Date.now() }
) {
  const authTime = Math.floor(now / 1000);

  return systemDb.transaction(async (tx) => {
    await tx.run(
      `UPDATE sessions
          SET auth_time = {authTime}, last_seen_at = {now}
        WHERE id = {id}`,
      { authTime, now, id: sessionId }
    );
    await tx.run(
      `UPDATE session_realms
          SET revoked_at = NULL, revoked_by = NULL, last_seen_at = {now}
        WHERE session_id = {sessionId} AND realm_id = {realmId}`,
      { now, sessionId, realmId }
    );
    return authTime;
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
