export async function getBan(db, { userId, clientId }) {
  return db.get(
    `SELECT user_id, client_id, created_by, created_at
       FROM app_bans
      WHERE user_id = {userId} AND client_id = {clientId}`,
    { userId, clientId }
  );
}

export async function getActiveBan(db, { userId, clientId }) {
  return db.get(
    `SELECT user_id, client_id, created_by, created_at
       FROM app_bans
      WHERE user_id = {userId}
        AND (client_id = {clientId} OR client_id = '*')
      ORDER BY CASE WHEN client_id = '*' THEN 1 ELSE 0 END
      LIMIT 1`,
    { userId, clientId }
  );
}

export async function isUserBanned(db, { userId, clientId }) {
  return Boolean(await getActiveBan(db, { userId, clientId }));
}

export async function createBan(db, { userId, clientId, createdBy = null, now = Date.now() }) {
  await db.run(
    `INSERT INTO app_bans (user_id, client_id, created_by, created_at)
     VALUES ({userId}, {clientId}, {createdBy}, {now})
     ON CONFLICT(user_id, client_id) DO NOTHING`,
    { userId, clientId, createdBy, now }
  );
  return getBan(db, { userId, clientId });
}

export async function deleteBan(db, { userId, clientId }) {
  const result = await db.run(
    `DELETE FROM app_bans
      WHERE user_id = {userId} AND client_id = {clientId}`,
    { userId, clientId }
  );
  return result.changes > 0;
}

export function serializeBan(ban) {
  if (!ban) return null;
  return {
    user_id: ban.user_id,
    client_id: ban.client_id,
    created_by: ban.created_by,
    created_at: ban.created_at,
  };
}

export async function revokeBannedClientAccess(
  systemDb,
  { userId, realmId, clientId, now = Date.now() }
) {
  return systemDb.transaction(async (tx) => {
    const consents = await tx.run(
      `UPDATE client_consents
          SET revoked_at = {now}, updated_at = {now}
        WHERE user_id = {userId} AND realm_id = {realmId}
          AND client_id = {clientId} AND revoked_at IS NULL`,
      { userId, realmId, clientId, now }
    );
    const refreshTokens = await tx.run(
      `UPDATE refresh_tokens
          SET revoked_at = {now}
        WHERE user_id = {userId} AND realm_id = {realmId}
          AND client_id = {clientId} AND revoked_at IS NULL`,
      { userId, realmId, clientId, now }
    );
    return {
      consents: consents.changes,
      refresh_tokens: refreshTokens.changes,
    };
  });
}

export async function revokeBannedRealmAccess(
  systemDb,
  { userId, realmId, now = Date.now() }
) {
  return systemDb.transaction(async (tx) => {
    const consents = await tx.run(
      `UPDATE client_consents
          SET revoked_at = {now}, updated_at = {now}
        WHERE user_id = {userId} AND realm_id = {realmId}
          AND client_id NOT IN ('admin', 'account')
          AND revoked_at IS NULL`,
      { userId, realmId, now }
    );
    const refreshTokens = await tx.run(
      `UPDATE refresh_tokens
          SET revoked_at = {now}
        WHERE user_id = {userId} AND realm_id = {realmId}
          AND client_id NOT IN ('admin', 'account')
          AND revoked_at IS NULL`,
      { userId, realmId, now }
    );
    return {
      consents: consents.changes,
      refresh_tokens: refreshTokens.changes,
    };
  });
}
