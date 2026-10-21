import crypto from 'node:crypto';

export const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function nextToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function insertRefreshToken(tx, {
  token,
  familyId,
  sessionId,
  userId,
  realmId,
  clientId,
  scopes,
  now,
}) {
  const id = hashToken(token);
  const expiresAt = now + REFRESH_TOKEN_TTL * 1000;
  await tx.run(
    `INSERT INTO refresh_tokens
      (id, family_id, session_id, user_id, realm_id, client_id, scopes,
       created_at, expires_at, consumed_at, replaced_by, revoked_at)
     VALUES
      ({id}, {familyId}, {sessionId}, {userId}, {realmId}, {clientId}, {scopes},
       {now}, {expiresAt}, NULL, NULL, NULL)`,
    {
      id,
      familyId,
      sessionId,
      userId,
      realmId,
      clientId,
      scopes,
      now,
      expiresAt,
    }
  );
  return { id, token, expiresAt };
}

export async function issueRefreshToken(
  systemDb,
  { sessionId, userId, realmId = null, clientId, scopes, now = Date.now() }
) {
  const familyId = crypto.randomUUID();
  const token = nextToken();
  return systemDb.transaction((tx) =>
    insertRefreshToken(tx, {
      token,
      familyId,
      sessionId,
      userId,
      realmId,
      clientId,
      scopes,
      now,
    })
  );
}

async function revokeFamily(tx, familyId, now) {
  await tx.run(
    `UPDATE refresh_tokens
        SET revoked_at = {now}
      WHERE family_id = {familyId} AND revoked_at IS NULL`,
    { familyId, now }
  );
}

export async function rotateRefreshToken(
  systemDb,
  token,
  { validate, now = Date.now() } = {}
) {
  if (!token) return { status: 'invalid' };

  return systemDb.transaction(async (tx) => {
    const row = await tx.get(
      `SELECT id, family_id, session_id, user_id, realm_id, client_id, scopes,
              created_at, expires_at, consumed_at, replaced_by, revoked_at
         FROM refresh_tokens
        WHERE id = {id}`,
      { id: hashToken(token) }
    );
    if (!row || row.revoked_at) return { status: 'invalid' };
    if (row.consumed_at) {
      await revokeFamily(tx, row.family_id, now);
      return { status: 'reuse' };
    }
    if (row.expires_at <= now) return { status: 'expired' };

    if (validate && !(await validate(row, tx))) {
      await revokeFamily(tx, row.family_id, now);
      return { status: 'denied' };
    }

    const next = nextToken();
    const nextId = hashToken(next);
    const expiresAt = now + REFRESH_TOKEN_TTL * 1000;
    await tx.run(
      `UPDATE refresh_tokens
          SET consumed_at = {now}, replaced_by = {nextId}
        WHERE id = {id}`,
      { now, nextId, id: row.id }
    );
    await insertRefreshToken(tx, {
      token: next,
      familyId: row.family_id,
      sessionId: row.session_id,
      userId: row.user_id,
      realmId: row.realm_id,
      clientId: row.client_id,
      scopes: row.scopes,
      now,
    });

    return {
      status: 'ok',
      token: next,
      expiresAt,
      row,
    };
  });
}
