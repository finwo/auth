import { isSystemAdmin } from './policy.js';

const ADMIN_SESSION_FIELDS = `
  s.id, s.public_id, s.group_id, s.user_id, s.scope_type, s.scope_host,
  s.client_id, s.created_at, s.last_seen_at, s.expires_at, s.user_agent, s.ip,
  u.username, u.display_name, u.home_realm_id, u.status AS user_status,
  sr.revoked_at, sr.revoked_by
`;

function serialize(row, actor, realmId) {
  return {
    public_id: row.public_id,
    user: {
      id: row.user_id,
      username: row.username,
      display_name: row.display_name,
      home_realm_id: row.home_realm_id,
      status: row.user_status,
    },
    scope: {
      type: row.scope_type,
      host: row.scope_host,
      client_id: row.client_id,
    },
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
    user_agent: row.user_agent,
    ip: row.ip,
    revoked_at: row.revoked_at,
    revoked_by: row.revoked_by,
    can_terminate: canTerminateSession(actor, row, realmId),
  };
}

export function canTerminateSession(actor, session, realmId) {
  return isSystemAdmin(actor) || session.home_realm_id === realmId;
}

export async function listAdminRealmSessions(
  systemDb,
  { realmId, actor, now = Date.now() }
) {
  const rows = await systemDb.all(
    `SELECT ${ADMIN_SESSION_FIELDS}
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN session_realms sr
         ON sr.session_id = s.id AND sr.realm_id = {realmId}
      WHERE s.expires_at > {now}
        AND (u.home_realm_id = {realmId} OR sr.session_id IS NOT NULL)
      ORDER BY s.last_seen_at DESC, s.created_at DESC`,
    { realmId, now }
  );

  return rows.map((row) => serialize(row, actor, realmId));
}

export async function findAdminRealmSession(
  systemDb,
  { realmId, publicId, now = Date.now() }
) {
  return systemDb.get(
    `SELECT ${ADMIN_SESSION_FIELDS}
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN session_realms sr
         ON sr.session_id = s.id AND sr.realm_id = {realmId}
      WHERE s.public_id = {publicId}
        AND s.expires_at > {now}
        AND (u.home_realm_id = {realmId} OR sr.session_id IS NOT NULL)
      LIMIT 1`,
    { realmId, publicId, now }
  );
}
