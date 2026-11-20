import crypto from 'node:crypto';
import { normalizeScopes } from './admin-clients.js';
import { HttpError } from './http/http-error.js';
import { getRealmEmailDomain, validateRealmEmailDomain } from './realm.js';

const SLUG_MAX_LENGTH = 63;
const NAME_MAX_LENGTH = 120;
const CLIENT_ID_MAX_LENGTH = 255;
const SECRET_MAX_LENGTH = 255;
const ISSUER_MAX_LENGTH = 512;
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const PRINTABLE_PATTERN = /^[\x21-\x7e]+$/;

const PROVIDER_COLUMNS =
  'id, slug, display_name, issuer, client_id, client_secret, scopes, enabled, created_at, updated_at';

function invalidRequest(message) {
  return new HttpError(400, 'invalid_request', message);
}

function notFound(message = 'Identity provider not found', code = 'provider_not_found') {
  return new HttpError(404, code, message);
}

function conflict(message, code) {
  return new HttpError(409, code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function validateSlug(value) {
  if (typeof value !== 'string') {
    throw invalidRequest('slug must be a string');
  }
  const slug = value.trim().toLowerCase();
  if (!slug || slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) {
    throw invalidRequest(
      'slug must contain only lowercase letters, digits, and hyphens, and must start and end with a letter or digit'
    );
  }
  return slug;
}

function validateDisplayName(value) {
  if (typeof value !== 'string') {
    throw invalidRequest('display_name must be a string');
  }
  const name = value.trim();
  if (!name || name.length > NAME_MAX_LENGTH) {
    throw invalidRequest(`display_name must be between 1 and ${NAME_MAX_LENGTH} characters`);
  }
  return name;
}

function validateIssuer(value) {
  if (typeof value !== 'string') {
    throw invalidRequest('issuer must be a string');
  }
  const issuer = value.trim();
  if (!issuer || issuer.length > ISSUER_MAX_LENGTH) {
    throw invalidRequest(`issuer must be between 1 and ${ISSUER_MAX_LENGTH} characters`);
  }
  if (issuer.endsWith('/')) {
    throw invalidRequest('issuer must not end with a slash');
  }

  let parsed;
  try {
    parsed = new URL(issuer);
  } catch {
    throw invalidRequest('issuer must be an absolute URL');
  }
  if (parsed.protocol !== 'https:') {
    throw invalidRequest('issuer must use https');
  }
  if (parsed.username || parsed.password) {
    throw invalidRequest('issuer must not contain credentials');
  }
  if (parsed.search) {
    throw invalidRequest('issuer must not contain a query');
  }
  if (parsed.hash) {
    throw invalidRequest('issuer must not contain a fragment');
  }
  if (!parsed.hostname.includes('.')) {
    throw invalidRequest('issuer must include a complete hostname such as https://idp.example.com');
  }
  return issuer;
}

function validateProviderClientId(value) {
  if (typeof value !== 'string') {
    throw invalidRequest('client_id must be a string');
  }
  const clientId = value.trim();
  if (!clientId || clientId.length > CLIENT_ID_MAX_LENGTH) {
    throw invalidRequest(`client_id must be between 1 and ${CLIENT_ID_MAX_LENGTH} characters`);
  }
  if (!PRINTABLE_PATTERN.test(clientId)) {
    throw invalidRequest('client_id must contain only printable non-whitespace characters');
  }
  return clientId;
}

function validateSecret(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidRequest('client_secret must be a non-empty string');
  }
  if (value.length > SECRET_MAX_LENGTH) {
    throw invalidRequest(`client_secret must be ${SECRET_MAX_LENGTH} characters or fewer`);
  }
  return value;
}

function validateEnabled(value) {
  if (typeof value !== 'boolean') {
    throw invalidRequest('enabled must be a boolean');
  }
  return value;
}

function normalizeEmailDomainKey(domain) {
  return String(domain || '').trim().toLowerCase().replace(/\.$/, '');
}

export function normalizeCreateProviderInput(body) {
  assertBody(body);
  assertKnownFields(
    body,
    new Set([
      'slug',
      'display_name',
      'issuer',
      'client_id',
      'client_secret',
      'scopes',
      'enabled',
    ])
  );

  if (!Object.hasOwn(body, 'display_name')) {
    throw invalidRequest('display_name is required');
  }
  if (!Object.hasOwn(body, 'issuer')) {
    throw invalidRequest('issuer is required');
  }
  if (!Object.hasOwn(body, 'client_id')) {
    throw invalidRequest('client_id is required');
  }
  if (body.client_secret !== undefined && body.client_secret !== null && typeof body.client_secret !== 'string') {
    throw invalidRequest('client_secret must be a string');
  }

  return {
    slug: validateSlug(body.slug),
    displayName: validateDisplayName(body.display_name),
    issuer: validateIssuer(body.issuer),
    clientId: validateProviderClientId(body.client_id),
    clientSecret:
      body.client_secret === undefined || body.client_secret === null
        ? null
        : validateSecret(body.client_secret),
    scopes: normalizeScopes(body.scopes),
    enabled: validateEnabled(body.enabled === undefined ? true : body.enabled),
  };
}

export function normalizeUpdateProviderInput(body) {
  assertBody(body);
  if (Object.hasOwn(body, 'slug')) {
    throw invalidRequest('slug cannot be updated');
  }
  assertKnownFields(
    body,
    new Set(['display_name', 'issuer', 'client_id', 'client_secret', 'scopes', 'enabled'])
  );

  const result = {};
  if (Object.hasOwn(body, 'display_name')) {
    result.displayName = validateDisplayName(body.display_name);
  }
  if (Object.hasOwn(body, 'issuer')) result.issuer = validateIssuer(body.issuer);
  if (Object.hasOwn(body, 'client_id')) result.clientId = validateProviderClientId(body.client_id);
  if (Object.hasOwn(body, 'scopes')) result.scopes = normalizeScopes(body.scopes);
  if (Object.hasOwn(body, 'enabled')) result.enabled = validateEnabled(body.enabled);
  if (Object.hasOwn(body, 'client_secret')) {
    result.secret =
      body.client_secret === null
        ? { mode: 'clear' }
        : { mode: 'set', value: validateSecret(body.client_secret) };
  }

  if (Object.keys(result).length === 0) {
    throw invalidRequest('At least one field must be provided');
  }
  return result;
}

function serializeProvider(row, domains) {
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    issuer: row.issuer,
    client_id: row.client_id,
    scopes: row.scopes,
    enabled: Boolean(row.enabled),
    has_secret: row.client_secret !== null && String(row.client_secret) !== '',
    domains,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getAdminProviderRow(realmDb, slug) {
  return realmDb.get(
    `SELECT ${PROVIDER_COLUMNS} FROM identity_providers WHERE slug = {slug}`,
    { slug }
  );
}

async function loadProviderDomains(realmDb, providerId) {
  const rows = await realmDb.all(
    'SELECT domain FROM email_domain_providers WHERE provider_id = {providerId} ORDER BY domain ASC',
    { providerId }
  );
  return rows.map((row) => row.domain);
}

export async function listAdminRealmProviders({ realmDb }) {
  const rows = await realmDb.all(
    `SELECT ${PROVIDER_COLUMNS} FROM identity_providers ORDER BY display_name ASC, slug ASC`
  );
  const mappings = await realmDb.all(
    'SELECT provider_id, domain FROM email_domain_providers ORDER BY domain ASC'
  );

  const domainsByProvider = new Map();
  for (const mapping of mappings) {
    const current = domainsByProvider.get(mapping.provider_id) || [];
    current.push(mapping.domain);
    domainsByProvider.set(mapping.provider_id, current);
  }

  return rows.map((row) => serializeProvider(row, domainsByProvider.get(row.id) || []));
}

export async function getAdminRealmProvider({ realmDb, slug }) {
  const row = await getAdminProviderRow(realmDb, slug);
  if (!row) return null;
  return serializeProvider(row, await loadProviderDomains(realmDb, row.id));
}

function mapProviderDatabaseError(error) {
  if (/UNIQUE constraint failed: identity_providers\.slug/.test(String(error?.message || ''))) {
    return conflict('This slug is already used by a provider in the realm.', 'provider_slug_exists');
  }
  throw error;
}

export async function createAdminRealmProvider({ realmDb, input }) {
  const existing = await getAdminProviderRow(realmDb, input.slug);
  if (existing) {
    throw conflict('This slug is already used by a provider in the realm.', 'provider_slug_exists');
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await realmDb.run(
      `INSERT INTO identity_providers
        (id, slug, display_name, issuer, client_id, client_secret, scopes, enabled, created_at, updated_at)
       VALUES
        ({id}, {slug}, {displayName}, {issuer}, {clientId}, {clientSecret}, {scopes}, {enabled}, {createdAt}, {updatedAt})`,
      {
        id,
        slug: input.slug,
        displayName: input.displayName,
        issuer: input.issuer,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        scopes: input.scopes,
        enabled: input.enabled ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      }
    );
  } catch (error) {
    mapProviderDatabaseError(error);
  }

  return serializeProvider(
    {
      id,
      slug: input.slug,
      display_name: input.displayName,
      issuer: input.issuer,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      scopes: input.scopes,
      enabled: input.enabled ? 1 : 0,
      created_at: now,
      updated_at: now,
    },
    []
  );
}

export async function updateAdminRealmProvider({ realmDb, slug, input }) {
  const row = await getAdminProviderRow(realmDb, slug);
  if (!row) {
    throw notFound();
  }

  const next = {
    displayName: input.displayName ?? row.display_name,
    issuer: input.issuer ?? row.issuer,
    clientId: input.clientId ?? row.client_id,
    scopes: input.scopes ?? row.scopes,
    enabled: input.enabled ?? Boolean(row.enabled),
  };
  let clientSecret = row.client_secret;
  if (input.secret) {
    clientSecret = input.secret.mode === 'clear' ? null : input.secret.value;
  }
  const now = Date.now();

  await realmDb.run(
    `UPDATE identity_providers
        SET display_name = {displayName}, issuer = {issuer}, client_id = {clientId},
            client_secret = {clientSecret}, scopes = {scopes}, enabled = {enabled},
            updated_at = {updatedAt}
      WHERE id = {id}`,
    {
      displayName: next.displayName,
      issuer: next.issuer,
      clientId: next.clientId,
      clientSecret,
      scopes: next.scopes,
      enabled: next.enabled ? 1 : 0,
      updatedAt: now,
      id: row.id,
    }
  );

  return serializeProvider(
    {
      ...row,
      display_name: next.displayName,
      issuer: next.issuer,
      client_id: next.clientId,
      client_secret: clientSecret,
      scopes: next.scopes,
      enabled: next.enabled ? 1 : 0,
      updated_at: now,
    },
    await loadProviderDomains(realmDb, row.id)
  );
}

export async function deleteAdminRealmProvider({ realmDb, slug }) {
  const row = await getAdminProviderRow(realmDb, slug);
  if (!row) {
    throw notFound();
  }

  let unlinkedDomains = [];
  await realmDb.transaction(async (tx) => {
    const mappings = await tx.all(
      'SELECT domain FROM email_domain_providers WHERE provider_id = {providerId} ORDER BY domain ASC',
      { providerId: row.id }
    );
    unlinkedDomains = mappings.map((mapping) => mapping.domain);
    // email_domain_providers cascade-deletes through the ON DELETE CASCADE FK.
    await tx.run('DELETE FROM identity_providers WHERE id = {id}', { id: row.id });
  });

  return { removed: true, slug: row.slug, unlinked_domains: unlinkedDomains };
}

async function requireAdminProvider(realmDb, slug) {
  const row = await getAdminProviderRow(realmDb, slug);
  if (!row) {
    throw notFound();
  }
  return row;
}

export async function connectAdminProviderDomain({ systemDb, realm, realmDb, slug, domain }) {
  const normalized = validateRealmEmailDomain(domain);
  const provider = await requireAdminProvider(realmDb, slug);

  const emailDomain = await getRealmEmailDomain(systemDb, realm.id, normalized);
  if (!emailDomain || !emailDomain.verified) {
    throw conflict(
      'Email domain must be a verified email domain of this realm.',
      'domain_unavailable'
    );
  }

  const existing = await realmDb.get(
    'SELECT provider_id FROM email_domain_providers WHERE domain = {domain}',
    { domain: normalized }
  );
  if (existing) {
    if (existing.provider_id === provider.id) {
      return { domain: normalized, already_connected: true };
    }
    throw conflict(
      'This email domain is already connected to another provider.',
      'domain_in_use'
    );
  }

  try {
    await realmDb.run(
      'INSERT INTO email_domain_providers (domain, provider_id, created_at) VALUES ({domain}, {providerId}, {createdAt})',
      { domain: normalized, providerId: provider.id, createdAt: Date.now() }
    );
  } catch (error) {
    if (/UNIQUE constraint failed: email_domain_providers\.domain/.test(String(error?.message || ''))) {
      throw conflict(
        'This email domain is already connected to another provider.',
        'domain_in_use'
      );
    }
    throw error;
  }

  return { domain: normalized };
}

export async function disconnectAdminProviderDomain({ realmDb, slug, domain }) {
  const normalized = normalizeEmailDomainKey(domain);
  const provider = await requireAdminProvider(realmDb, slug);

  if (!normalized) {
    throw notFound('Email domain is not connected to this provider.', 'domain_not_found');
  }
  const result = await realmDb.run(
    'DELETE FROM email_domain_providers WHERE domain = {domain} AND provider_id = {providerId}',
    { domain: normalized, providerId: provider.id }
  );
  if (!result.changes) {
    throw notFound('Email domain is not connected to this provider.', 'domain_not_found');
  }

  return { removed: true, domain: normalized };
}
