export function splitScopes(value) {
  return [...new Set(String(value || '').split(/\s+/).filter(Boolean))];
}

function scopeSet(value) {
  return new Set(splitScopes(value));
}

export function scopesCovered(consented, requested) {
  const granted = scopeSet(consented);
  return splitScopes(requested).every((scope) => granted.has(scope));
}

function mergeScopes(left, right) {
  return splitScopes([...splitScopes(left), ...splitScopes(right)].join(' ')).join(' ');
}

export async function getConsent(db, { userId, realmId, clientId }) {
  return db.get(
    `SELECT user_id, realm_id, client_id, scopes, granted_via, created_at,
            updated_at, revoked_at
       FROM client_consents
      WHERE user_id = {userId} AND realm_id = {realmId} AND client_id = {clientId}`,
    { userId, realmId, clientId }
  );
}

export async function recordConsent(
  db,
  { userId, realmId, clientId, scopes: requestedScopes, grantedVia = 'user', now = Date.now() }
) {
  return db.transaction(async (tx) => {
    const existing = await getConsent(tx, { userId, realmId, clientId });
    const scopes =
      existing && !existing.revoked_at
        ? mergeScopes(existing.scopes, requestedScopes)
        : splitScopes(requestedScopes).join(' ');
    const granted_via =
      grantedVia === 'user' || existing?.granted_via === 'user' ? 'user' : 'trusted';

    if (existing) {
      await tx.run(
        `UPDATE client_consents
            SET scopes = {scopes}, granted_via = {grantedVia}, updated_at = {now},
                revoked_at = NULL
          WHERE user_id = {userId} AND realm_id = {realmId} AND client_id = {clientId}`,
        { scopes, grantedVia: granted_via, now, userId, realmId, clientId }
      );
      return {
        ...existing,
        scopes,
        granted_via,
        updated_at: now,
        revoked_at: null,
      };
    }

    await tx.run(
      `INSERT INTO client_consents
        (user_id, realm_id, client_id, scopes, granted_via, created_at,
         updated_at, revoked_at)
       VALUES
        ({userId}, {realmId}, {clientId}, {scopes}, {grantedVia}, {now}, {now}, NULL)`,
      { userId, realmId, clientId, scopes, grantedVia: granted_via, now }
    );
    return {
      user_id: userId,
      realm_id: realmId,
      client_id: clientId,
      scopes,
      granted_via,
      created_at: now,
      updated_at: now,
      revoked_at: null,
    };
  });
}

export async function revokeConsent(
  db,
  { userId, realmId, clientId, now = Date.now() }
) {
  return db.transaction(async (tx) => {
    const existing = await getConsent(tx, { userId, realmId, clientId });
    if (existing) {
      await tx.run(
        `UPDATE client_consents
            SET revoked_at = {now}, updated_at = {now}
          WHERE user_id = {userId} AND realm_id = {realmId} AND client_id = {clientId}`,
        { now, userId, realmId, clientId }
      );
      return { ...existing, revoked_at: now, updated_at: now };
    }

    await tx.run(
      `INSERT INTO client_consents
        (user_id, realm_id, client_id, scopes, granted_via, created_at,
         updated_at, revoked_at)
       VALUES
        ({userId}, {realmId}, {clientId}, '', 'user', {now}, {now}, {now})`,
      { userId, realmId, clientId, now }
    );
    return {
      user_id: userId,
      realm_id: realmId,
      client_id: clientId,
      scopes: '',
      granted_via: 'user',
      created_at: now,
      updated_at: now,
      revoked_at: now,
    };
  });
}

export async function revokeConsentRefreshTokens(
  db,
  { userId, realmId, clientId, now = Date.now() }
) {
  const result = await db.run(
    `UPDATE refresh_tokens
        SET revoked_at = {now}
      WHERE user_id = {userId} AND realm_id = {realmId}
        AND client_id = {clientId} AND revoked_at IS NULL`,
    { userId, realmId, clientId, now }
  );
  return result.changes;
}

export function consentStatus({ client, user, realm, consent, scope }) {
  if (client?.system_client) {
    return { required: false, autoGrant: false, reason: 'system', consent: null };
  }
  if (!client || !realm) {
    return { required: true, autoGrant: false, reason: 'context', consent: null };
  }

  const homeRealm = user?.home_realm_id === realm.id;
  if (client.consent_mode === 'trusted' && homeRealm) {
    if (consent?.revoked_at) {
      return { required: true, autoGrant: false, reason: 'revoked', consent };
    }
    return { required: false, autoGrant: true, reason: 'trusted', consent };
  }

  if (!consent || consent.revoked_at) {
    return {
      required: true,
      autoGrant: false,
      reason: consent?.revoked_at ? 'revoked' : 'missing',
      consent,
    };
  }
  if (consent.granted_via !== 'user') {
    return { required: true, autoGrant: false, reason: 'trusted_grant', consent };
  }
  if (!scopesCovered(consent.scopes, scope)) {
    return { required: true, autoGrant: false, reason: 'scopes', consent };
  }

  return { required: false, autoGrant: false, reason: 'granted', consent };
}
