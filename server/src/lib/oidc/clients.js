import crypto from 'node:crypto';

const SYSTEM_CLIENTS = {
  admin: {
    id: 'system:admin',
    client_id: 'admin',
    name: 'Admin',
    access_mode: 'admin',
    enabled: 1,
    require_pkce: 1,
    token_endpoint_auth_method: 'none',
    redirect_uris: [],
    post_logout_redirect_uris: [],
    branding: {},
    required_roles: [],
    system_client: true,
  },
  account: {
    id: 'system:account',
    client_id: 'account',
    name: 'Account',
    access_mode: 'public',
    enabled: 1,
    require_pkce: 1,
    token_endpoint_auth_method: 'none',
    redirect_uris: [],
    post_logout_redirect_uris: [],
    branding: {},
    required_roles: [],
    system_client: true,
  },
};

function parseJson(raw, fallback) {
  try {
    return JSON.parse(raw || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

export function hashClientSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function isSystemClient(clientId) {
  return Object.hasOwn(SYSTEM_CLIENTS, clientId);
}

export function getSystemClient(clientId) {
  const client = SYSTEM_CLIENTS[clientId];
  return client ? { ...client } : null;
}

export async function getClient(db, clientId) {
  const system = SYSTEM_CLIENTS[clientId];
  if (system) return { ...system };

  const row = await db.get(
    `SELECT id, client_id, name, redirect_uris, scopes, access_mode, enabled,
            client_secret_hash, token_endpoint_auth_method, require_pkce,
            post_logout_redirect_uris, branding, consent_mode
       FROM oidc_clients
      WHERE client_id = {clientId}`,
    { clientId }
  );
  if (!row) return null;

  const roles = await db.all(
    `SELECT r.slug
       FROM oidc_client_roles cr
       JOIN roles r ON r.id = cr.role_id
      WHERE cr.client_id = {id}`,
    { id: row.id }
  );

  return {
    ...row,
    enabled: Boolean(row.enabled),
    require_pkce: Boolean(row.require_pkce),
    redirect_uris: parseJson(row.redirect_uris, []),
    post_logout_redirect_uris: parseJson(row.post_logout_redirect_uris, []),
    branding: parseJson(row.branding, {}),
    required_roles: roles.map((role) => role.slug),
    system_client: false,
  };
}

export function redirectUriAllowed(client, redirectUri, systemCallbacks = []) {
  if (client.system_client) return systemCallbacks.includes(redirectUri);
  return client.redirect_uris.includes(redirectUri);
}

export function postLogoutRedirectAllowed(client, redirectUri, systemCallbacks = []) {
  if (!redirectUri) return true;
  if (client.system_client) return systemCallbacks.includes(redirectUri);
  return client.post_logout_redirect_uris.includes(redirectUri);
}

export function authenticateClient(req, client, body = {}) {
  const method = client.token_endpoint_auth_method || 'none';

  if (method === 'none') {
    return !body.client_id || body.client_id === client.client_id;
  }

  if (method !== 'client_secret_basic' || !client.client_secret_hash) {
    return false;
  }

  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) return false;

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }

  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  const clientId = decoded.slice(0, colon);
  const secret = decoded.slice(colon + 1);
  if (clientId !== client.client_id) return false;

  const expected = Buffer.from(client.client_secret_hash, 'hex');
  const actual = Buffer.from(hashClientSecret(secret), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
