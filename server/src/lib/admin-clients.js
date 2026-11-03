import crypto from 'node:crypto';
import {
  applyBrandingPatch,
  hasBrandingPatch,
  normalizeBrandingPatch,
  serializeBranding,
} from './admin-branding.js';
import { addClientRealm, findClientRealm } from './realm.js';
import { hashClientSecret } from './oidc/clients.js';
import { HttpError } from './http/http-error.js';
import { destroySessionById } from './session.js';

const DEFAULT_SCOPES = 'openid profile email';
const CLIENT_ID_MAX_LENGTH = 64;
const NAME_MAX_LENGTH = 100;
const URI_MAX_LENGTH = 2048;
const MAX_URI_COUNT = 10;
const MAX_SCOPE_COUNT = 50;
const MAX_ROLE_COUNT = 20;
const RESERVED_CLIENT_IDS = new Set(['admin', 'account']);
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ACCESS_MODES = new Set(['internal', 'members', 'public']);
const CONSENT_MODES = new Set(['remembered', 'trusted']);
const TOKEN_AUTH_METHODS = new Set(['none', 'client_secret_basic']);

function invalidRequest(message, code = 'invalid_request') {
  return new HttpError(400, code, message);
}

function notFound(message, code = 'client_not_found') {
  return new HttpError(404, code, message);
}

function conflict(message, code = 'client_id_exists') {
  return new HttpError(409, code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(raw, fallback) {
  try {
    return JSON.parse(raw || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function assertBody(body) {
  if (!isPlainObject(body)) {
    throw invalidRequest('Request body must be a JSON object');
  }
}

function assertKnownFields(body, allowed) {
  for (const field of Object.keys(body)) {
    if (!allowed.has(field)) {
      throw invalidRequest(`Unknown field: ${field}`);
    }
  }
}

function validateEnum(value, values, field) {
  if (!values.has(value)) {
    throw invalidRequest(`${field} must be one of ${[...values].join(', ')}`);
  }
  return value;
}

function validateBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw invalidRequest(`${field} must be a boolean`);
  }
  return value;
}

function validateClientId(value) {
  if (typeof value !== 'string') {
    throw invalidRequest('client_id must be a string', 'invalid_client_id');
  }
  const clientId = value.trim();
  if (!CLIENT_ID_PATTERN.test(clientId) || clientId.length > CLIENT_ID_MAX_LENGTH) {
    throw invalidRequest(
      'client_id must contain only lowercase letters, digits, and hyphens, and must start with a letter or digit',
      'invalid_client_id'
    );
  }
  if (RESERVED_CLIENT_IDS.has(clientId)) {
    throw invalidRequest('This client_id is reserved', 'reserved_client_id');
  }
  return clientId;
}

function validateName(value) {
  if (typeof value !== 'string') {
    throw invalidRequest('name must be a string');
  }
  const name = value.trim();
  if (!name || name.length > NAME_MAX_LENGTH) {
    throw invalidRequest(`name must be between 1 and ${NAME_MAX_LENGTH} characters`);
  }
  return name;
}

export function normalizeScopes(value) {
  let raw = value;
  if (raw === undefined || raw === null) raw = DEFAULT_SCOPES;
  if (Array.isArray(raw)) raw = raw.join(' ');
  if (typeof raw !== 'string') {
    throw invalidRequest('scopes must be a string or an array of strings');
  }

  const scopes = [...new Set(raw.trim().split(/\s+/).filter(Boolean))];
  if (!scopes.includes('openid')) {
    throw invalidRequest('scopes must include openid');
  }
  if (scopes.length > MAX_SCOPE_COUNT) {
    throw invalidRequest(`scopes may contain at most ${MAX_SCOPE_COUNT} entries`);
  }
  for (const scope of scopes) {
    if (!/^[\x21-\x7e]+$/.test(scope)) {
      throw invalidRequest('scopes must contain only printable non-whitespace characters');
    }
  }
  return scopes.join(' ');
}

export function normalizeUriList(value, field, { required = false } = {}) {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
    if (required) {
      throw invalidRequest(`${field} must contain at least one URL`);
    }
    return [];
  }

  let values;
  if (Array.isArray(value)) {
    values = value;
  } else if (typeof value === 'string') {
    values = value.trim().split(/\s+/);
  } else {
    throw invalidRequest(`${field} must be an array of URLs`);
  }

  if (values.length > MAX_URI_COUNT) {
    throw invalidRequest(`${field} may contain at most ${MAX_URI_COUNT} URLs`);
  }

  const result = new Set();
  for (const item of values) {
    if (typeof item !== 'string') {
      throw invalidRequest(`${field} must contain only strings`);
    }
    const uri = item.trim();
    if (!uri || uri.length > URI_MAX_LENGTH) {
      throw invalidRequest(
        `${field} URLs must be between 1 and ${URI_MAX_LENGTH} characters`
      );
    }
    if (uri.includes('*')) {
      throw invalidRequest(`${field} URLs cannot contain wildcards`);
    }

    let parsed;
    try {
      parsed = new URL(uri);
    } catch {
      throw invalidRequest(`${field} URLs must be absolute`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw invalidRequest(`${field} URLs must use http or https`);
    }
    if (parsed.username || parsed.password) {
      throw invalidRequest(`${field} URLs cannot contain credentials`);
    }
    if (parsed.hash) {
      throw invalidRequest(`${field} URLs cannot contain fragments`);
    }
    result.add(uri);
  }

  if (required && result.size === 0) {
    throw invalidRequest(`${field} must contain at least one URL`);
  }
  return [...result];
}

function mapMappingError(error) {
  const message = String(error?.message || '');
  if (/reserved/.test(message)) {
    return invalidRequest('This client_id is reserved', 'reserved_client_id');
  }
  if (/invalid client id/.test(message)) {
    return invalidRequest('client_id is invalid', 'invalid_client_id');
  }
  if (/already assigned/.test(message)) {
    return conflict();
  }
  return error;
}

function mapDatabaseError(error) {
  if (/UNIQUE constraint failed: oidc_clients\.client_id/.test(String(error?.message || ''))) {
    return conflict();
  }
  return error;
}

async function getKnownRoleSet(db) {
  const roles = await db.all('SELECT slug FROM roles');
  return new Set(roles.map((role) => role.slug));
}

function validateRoles(value, knownRoles) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw invalidRequest('required_roles must be an array');
  }
  if (value.length > MAX_ROLE_COUNT) {
    throw invalidRequest(`required_roles may contain at most ${MAX_ROLE_COUNT} entries`);
  }

  const result = new Set();
  for (const item of value) {
    if (typeof item !== 'string') {
      throw invalidRequest('required_roles must contain only strings');
    }
    const slug = item.trim();
    if (!slug) {
      throw invalidRequest('required_roles cannot contain empty values');
    }
    if (!knownRoles.has(slug)) {
      throw invalidRequest(`Unknown role: ${slug}`, 'unknown_role');
    }
    result.add(slug);
  }
  return [...result];
}

async function loadRoles(db, id) {
  const rows = await db.all(
    `SELECT r.slug
       FROM oidc_client_roles cr
       JOIN roles r ON r.id = cr.role_id
      WHERE cr.client_id = {id}
      ORDER BY r.slug ASC`,
    { id }
  );
  return rows.map((row) => row.slug);
}

function serializeClient(row, requiredRoles) {
  return {
    client_id: row.client_id,
    name: row.name,
    access_mode: row.access_mode,
    ...serializeBranding(row.branding),
    enabled: Boolean(row.enabled),
    scopes: row.scopes || DEFAULT_SCOPES,
    required_roles: requiredRoles,
    redirect_uris: parseJson(row.redirect_uris, []),
    post_logout_redirect_uris: parseJson(row.post_logout_redirect_uris, []),
    token_endpoint_auth_method: row.token_endpoint_auth_method || 'none',
    require_pkce: Boolean(row.require_pkce),
    consent_mode: row.consent_mode || 'remembered',
    has_secret: Boolean(row.client_secret_hash),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getAdminClientRow(db, clientId) {
  return db.get(
    `SELECT id, client_id, name, redirect_uris, scopes, access_mode, enabled,
            branding, client_secret_hash, token_endpoint_auth_method, require_pkce,
            post_logout_redirect_uris, consent_mode, created_at, updated_at
       FROM oidc_clients
      WHERE client_id = {clientId}`,
    { clientId }
  );
}

export async function loadAdminClient(db, clientId) {
  const row = await getAdminClientRow(db, clientId);
  if (!row) return null;
  return serializeClient(row, await loadRoles(db, row.id));
}

export async function listAdminRealmClients(systemDb, realmDb, realmId) {
  const mappedRows = await systemDb.all(
    'SELECT client_id FROM client_realms WHERE realm_id = {realmId} ORDER BY client_id ASC',
    { realmId }
  );
  const mapped = new Set(mappedRows.map((row) => row.client_id));
  if (mapped.size === 0) return [];

  const rows = await realmDb.all(
    `SELECT id, client_id, name, redirect_uris, scopes, access_mode, enabled,
            branding, client_secret_hash, token_endpoint_auth_method, require_pkce,
            post_logout_redirect_uris, consent_mode, created_at, updated_at
       FROM oidc_clients
      ORDER BY name COLLATE NOCASE ASC, client_id ASC`
  );
  const roleRows = await realmDb.all(
    `SELECT c.client_id, r.slug
       FROM oidc_client_roles cr
       JOIN roles r ON r.id = cr.role_id
       JOIN oidc_clients c ON c.id = cr.client_id
      ORDER BY r.slug ASC`
  );

  const rolesByClient = new Map();
  for (const role of roleRows) {
    const current = rolesByClient.get(role.client_id) || [];
    current.push(role.slug);
    rolesByClient.set(role.client_id, current);
  }

  return rows
    .filter((row) => mapped.has(row.client_id))
    .map((row) => serializeClient(row, rolesByClient.get(row.client_id) || []));
}

export async function listAdminRealmRoles(realmDb) {
  return realmDb.all(
    'SELECT slug, name FROM roles ORDER BY name COLLATE NOCASE ASC, slug ASC'
  );
}

function currentClientState(row) {
  return {
    name: row.name,
    access_mode: row.access_mode,
    enabled: Boolean(row.enabled),
    scopes: row.scopes || DEFAULT_SCOPES,
    redirect_uris: parseJson(row.redirect_uris, []),
    post_logout_redirect_uris: parseJson(row.post_logout_redirect_uris, []),
    token_endpoint_auth_method: row.token_endpoint_auth_method || 'none',
    require_pkce: Boolean(row.require_pkce),
    consent_mode: row.consent_mode || 'remembered',
  };
}

export function normalizeCreateInput(body) {
  assertBody(body);
  assertKnownFields(
    body,
    new Set([
      'client_id',
      'name',
      'access_mode',
      'enabled',
      'scopes',
      'required_roles',
      'redirect_uris',
      'post_logout_redirect_uris',
      'token_endpoint_auth_method',
      'require_pkce',
      'consent_mode',
      'logo_url',
      'primary_color',
    ])
  );

  const clientId = validateClientId(body.client_id);
  const name = validateName(body.name);
  const accessMode = validateEnum(
    body.access_mode === undefined ? 'members' : body.access_mode,
    ACCESS_MODES,
    'access_mode'
  );
  const consentMode = validateEnum(
    body.consent_mode === undefined ? 'remembered' : body.consent_mode,
    CONSENT_MODES,
    'consent_mode'
  );
  const enabled = validateBoolean(body.enabled === undefined ? true : body.enabled, 'enabled');
  const method = validateEnum(
    body.token_endpoint_auth_method === undefined ? 'none' : body.token_endpoint_auth_method,
    TOKEN_AUTH_METHODS,
    'token_endpoint_auth_method'
  );
  let requirePkce = validateBoolean(
    body.require_pkce === undefined ? true : body.require_pkce,
    'require_pkce'
  );
  if (method === 'none') requirePkce = true;

  return {
    clientId,
    name,
    accessMode,
    enabled,
    scopes: normalizeScopes(body.scopes),
    requiredRoles: body.required_roles ?? [],
    redirectUris: normalizeUriList(body.redirect_uris, 'redirect_uris', { required: true }),
    postLogoutRedirectUris: normalizeUriList(
      body.post_logout_redirect_uris,
      'post_logout_redirect_uris'
    ),
    tokenEndpointAuthMethod: method,
    requirePkce,
    consentMode,
    branding: normalizeBrandingPatch(body),
  };
}

export async function normalizeUpdateInput(body, db) {
  assertBody(body);
  if (Object.hasOwn(body, 'client_id')) {
    throw invalidRequest('client_id cannot be updated');
  }
  assertKnownFields(
    body,
    new Set([
      'name',
      'access_mode',
      'enabled',
      'scopes',
      'required_roles',
      'redirect_uris',
      'post_logout_redirect_uris',
      'token_endpoint_auth_method',
      'require_pkce',
      'consent_mode',
      'logo_url',
      'primary_color',
    ])
  );

  const knownRoles = await getKnownRoleSet(db);
  const result = {};
  if (Object.hasOwn(body, 'name')) result.name = validateName(body.name);
  if (Object.hasOwn(body, 'access_mode')) {
    result.accessMode = validateEnum(body.access_mode, ACCESS_MODES, 'access_mode');
  }
  if (Object.hasOwn(body, 'enabled')) result.enabled = validateBoolean(body.enabled, 'enabled');
  if (Object.hasOwn(body, 'consent_mode')) {
    result.consentMode = validateEnum(body.consent_mode, CONSENT_MODES, 'consent_mode');
  }
  if (Object.hasOwn(body, 'scopes')) result.scopes = normalizeScopes(body.scopes);
  if (Object.hasOwn(body, 'required_roles')) {
    result.requiredRoles = validateRoles(body.required_roles, knownRoles);
  }
  if (Object.hasOwn(body, 'redirect_uris')) {
    result.redirectUris = normalizeUriList(body.redirect_uris, 'redirect_uris', { required: true });
  }
  if (Object.hasOwn(body, 'post_logout_redirect_uris')) {
    result.postLogoutRedirectUris = normalizeUriList(
      body.post_logout_redirect_uris,
      'post_logout_redirect_uris'
    );
  }
  if (Object.hasOwn(body, 'token_endpoint_auth_method')) {
    result.tokenEndpointAuthMethod = validateEnum(
      body.token_endpoint_auth_method,
      TOKEN_AUTH_METHODS,
      'token_endpoint_auth_method'
    );
  }
  if (Object.hasOwn(body, 'require_pkce')) {
    result.requirePkce = validateBoolean(body.require_pkce, 'require_pkce');
  }
  Object.assign(result, normalizeBrandingPatch(body));
  if (Object.keys(result).length === 0) {
    throw invalidRequest('At least one field must be provided');
  }
  return result;
}

async function insertClientRoles(tx, clientId, roles) {
  for (const slug of roles) {
    const role = await tx.get('SELECT id FROM roles WHERE slug = {slug}', { slug });
    if (!role) {
      throw invalidRequest(`Unknown role: ${slug}`, 'unknown_role');
    }
    await tx.run(
      'INSERT INTO oidc_client_roles (client_id, role_id) VALUES ({clientId}, {roleId})',
      { clientId, roleId: role.id }
    );
  }
}

export function generateClientSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

export async function createAdminRealmClient({ systemDb, realmDb, realmId, input }) {
  const mapping = await findClientRealm(input.clientId);
  if (mapping) {
    throw conflict();
  }
  const existing = await getAdminClientRow(realmDb, input.clientId);
  if (existing) {
    throw conflict();
  }

  const knownRoles = await getKnownRoleSet(realmDb);
  const requiredRoles = validateRoles(input.requiredRoles, knownRoles);
  const clientId = crypto.randomUUID();
  const now = Date.now();
  const branding = applyBrandingPatch('{}', input.branding);
  const clientSecret =
    input.tokenEndpointAuthMethod === 'client_secret_basic' ? generateClientSecret() : null;

  try {
    await realmDb.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO oidc_clients
          (id, client_id, name, redirect_uris, scopes, access_mode, enabled, branding,
           client_secret_hash, token_endpoint_auth_method, require_pkce,
           post_logout_redirect_uris, consent_mode, created_at, updated_at)
          VALUES
           ({id}, {clientId}, {name}, {redirectUris}, {scopes}, {accessMode}, {enabled}, {branding},
            {clientSecretHash}, {tokenEndpointAuthMethod}, {requirePkce},
            {postLogoutRedirectUris}, {consentMode}, {createdAt}, {updatedAt})`,
        {
          id: clientId,
          clientId: input.clientId,
          name: input.name,
          redirectUris: JSON.stringify(input.redirectUris),
          scopes: input.scopes,
          accessMode: input.accessMode,
          enabled: input.enabled ? 1 : 0,
          branding,
          clientSecretHash: clientSecret ? hashClientSecret(clientSecret) : null,
          tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
          requirePkce: input.requirePkce ? 1 : 0,
          postLogoutRedirectUris: JSON.stringify(input.postLogoutRedirectUris),
          consentMode: input.consentMode,
          createdAt: now,
          updatedAt: now,
        }
      );
      await insertClientRoles(tx, clientId, requiredRoles);
    });
  } catch (error) {
    throw mapDatabaseError(error);
  }

  try {
    await addClientRealm(input.clientId, realmId);
  } catch (error) {
    await realmDb.run('DELETE FROM oidc_client_roles WHERE client_id = {id}', { id: clientId });
    await realmDb.run('DELETE FROM oidc_clients WHERE id = {id}', { id: clientId });
    throw mapMappingError(error);
  }

  const client = await loadAdminClient(realmDb, input.clientId);
  if (!client) {
    throw new HttpError(500, 'internal_error', 'Client was not created');
  }
  return { client, client_secret: clientSecret };
}

export async function updateAdminRealmClient({
  realmDb,
  clientId,
  body,
}) {
  const row = await getAdminClientRow(realmDb, clientId);
  if (!row) {
    throw notFound();
  }

  const current = currentClientState(row);
  const input = await normalizeUpdateInput(body, realmDb);
  const tokenEndpointAuthMethod =
    input.tokenEndpointAuthMethod ?? current.token_endpoint_auth_method;
  let requirePkce = input.requirePkce ?? current.require_pkce;
  if (tokenEndpointAuthMethod === 'none') {
    requirePkce = true;
  }
  if (tokenEndpointAuthMethod === 'none' && input.requirePkce === false) {
    throw invalidRequest('Public clients must require PKCE');
  }
  if (tokenEndpointAuthMethod === 'client_secret_basic' && !row.client_secret_hash) {
    throw new HttpError(
      409,
      'client_secret_required',
      'A client secret is required for client_secret_basic'
    );
  }

  const next = {
    name: input.name ?? current.name,
    accessMode: input.accessMode ?? current.access_mode,
    enabled: input.enabled ?? current.enabled,
    scopes: input.scopes ?? current.scopes,
    redirectUris: input.redirectUris ?? current.redirect_uris,
    postLogoutRedirectUris:
      input.postLogoutRedirectUris ?? current.post_logout_redirect_uris,
    tokenEndpointAuthMethod,
    requirePkce,
    consentMode: input.consentMode ?? current.consent_mode,
  };
  const branding = hasBrandingPatch(input)
    ? applyBrandingPatch(row.branding, input)
    : row.branding;
  const clientSecretHash =
    tokenEndpointAuthMethod === 'client_secret_basic' ? row.client_secret_hash : null;
  const now = Date.now();

  try {
    await realmDb.transaction(async (tx) => {
      await tx.run(
        `UPDATE oidc_clients
            SET name = {name}, redirect_uris = {redirectUris}, scopes = {scopes},
                access_mode = {accessMode}, enabled = {enabled}, branding = {branding},
                client_secret_hash = {clientSecretHash},
                token_endpoint_auth_method = {tokenEndpointAuthMethod},
                require_pkce = {requirePkce},
                post_logout_redirect_uris = {postLogoutRedirectUris},
                consent_mode = {consentMode}, updated_at = {updatedAt}
          WHERE id = {id}`,
        {
          name: next.name,
          redirectUris: JSON.stringify(next.redirectUris),
          scopes: next.scopes,
          accessMode: next.accessMode,
          enabled: next.enabled ? 1 : 0,
          branding,
          clientSecretHash,
          tokenEndpointAuthMethod: next.tokenEndpointAuthMethod,
          requirePkce: next.requirePkce ? 1 : 0,
          postLogoutRedirectUris: JSON.stringify(next.postLogoutRedirectUris),
          consentMode: next.consentMode,
          updatedAt: now,
          id: row.id,
        }
      );

      if (Object.hasOwn(input, 'requiredRoles')) {
        await tx.run('DELETE FROM oidc_client_roles WHERE client_id = {id}', { id: row.id });
        await insertClientRoles(tx, row.id, input.requiredRoles);
      }
    });
  } catch (error) {
    throw mapDatabaseError(error);
  }

  const client = await loadAdminClient(realmDb, clientId);
  if (!client) {
    throw new HttpError(500, 'internal_error', 'Client was not updated');
  }
  return client;
}

export async function rotateAdminClientSecret({ realmDb, clientId }) {
  const row = await getAdminClientRow(realmDb, clientId);
  if (!row) {
    throw notFound();
  }

  const clientSecret = generateClientSecret();
  await realmDb.run(
    `UPDATE oidc_clients
        SET client_secret_hash = {hash}, token_endpoint_auth_method = 'client_secret_basic',
            updated_at = {updatedAt}
      WHERE id = {id}`,
    {
      hash: hashClientSecret(clientSecret),
      updatedAt: Date.now(),
      id: row.id,
    }
  );

  const client = await loadAdminClient(realmDb, clientId);
  if (!client) {
    throw new HttpError(500, 'internal_error', 'Client secret was not updated');
  }
  return { client, client_secret: clientSecret };
}

async function deleteRealmClientState(realmDb, clientId, rowId) {
  await realmDb.transaction(async (tx) => {
    await tx.run('DELETE FROM oidc_client_roles WHERE client_id = {id}', { id: rowId });
    await tx.run('DELETE FROM auth_requests WHERE client_id = {clientId}', { clientId });
    await tx.run('DELETE FROM authorization_codes WHERE client_id = {clientId}', { clientId });
    await tx.run('DELETE FROM app_bans WHERE client_id = {clientId}', { clientId });
    await tx.run('DELETE FROM oidc_clients WHERE id = {id}', { id: rowId });
  });
}

export async function deleteAdminRealmClient({ systemDb, realmDb, realmId, clientId }) {
  const mapping = await findClientRealm(clientId);
  if (mapping && mapping.realm_id !== realmId) {
    throw notFound();
  }

  const row = await getAdminClientRow(realmDb, clientId);
  if (!row && !mapping) {
    throw notFound();
  }

  if (row) {
    await deleteRealmClientState(realmDb, clientId, row.id);
  }

  const now = Date.now();
  await systemDb.transaction(async (tx) => {
    const sessions = await tx.all(
      'SELECT id FROM sessions WHERE realm_id = {realmId} AND client_id = {clientId}',
      { realmId, clientId }
    );
    for (const session of sessions) {
      await destroySessionById(tx, session.id, now);
    }

    await tx.run(
      'DELETE FROM refresh_tokens WHERE realm_id = {realmId} AND client_id = {clientId}',
      { realmId, clientId }
    );
    await tx.run(
      'DELETE FROM client_consents WHERE realm_id = {realmId} AND client_id = {clientId}',
      { realmId, clientId }
    );
    if (mapping) {
      await tx.run('DELETE FROM client_realms WHERE client_id = {clientId}', { clientId });
    }
  });

  return { removed: true };
}
