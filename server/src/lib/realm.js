import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase, runMigrations } from './db/index.js';
import { MIGRATIONS_ROOT } from './db/migrate.js';
import { HttpError } from './http/http-error.js';

let systemDb = null;
let dialect = 'sqlite';
let realmsPath = null;
const realmDbs = new Map();

function migrationDir(dbDialect, type) {
  return path.join(MIGRATIONS_ROOT, dbDialect, type);
}

async function migrateRealm(db, label) {
  return runMigrations(db, {
    dir: migrationDir(db.dialect, 'realm'),
    namespace: 'realm',
    label,
  });
}

async function migrateSystem(db) {
  return runMigrations(db, {
    dir: migrationDir(db.dialect, 'system'),
    namespace: 'system',
    label: 'system',
  });
}

function parseBranding(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function ensureRole(db, slug, name, now) {
  const existing = await db.get('SELECT id FROM roles WHERE slug = {slug}', { slug });
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db.run(
    'INSERT INTO roles (id, slug, name, created_at) VALUES ({id}, {slug}, {name}, {createdAt})',
    { id, slug, name, createdAt: now }
  );
  return id;
}

async function seedRealmDefaults(db) {
  const now = Date.now();
  await ensureRole(db, 'realm-admin', 'Realm administrator', now);
}

async function writeRealmSettings(db, settings) {
  const now = Date.now();
  await db.run(
    `INSERT INTO realm_settings
      (id, slug, display_name, kind, status, branding, allow_session_duration_choice, created_at, updated_at)
     VALUES
      (1, {slug}, {displayName}, {kind}, 'active', {branding}, {allowChoice}, {createdAt}, {updatedAt})`,
    {
      slug: settings.slug,
      displayName: settings.displayName,
      kind: settings.kind || 'realm',
      branding: JSON.stringify(settings.branding || {}),
      allowChoice: settings.allowSessionDurationChoice === false ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    }
  );
}

export function normalizeHost(host) {
  let value = String(host || '').trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end !== -1) value = value.slice(0, end + 1);
  } else {
    const colon = value.indexOf(':');
    if (colon !== -1) value = value.slice(0, colon);
  }
  return value.replace(/\.$/, '');
}

export function normalizeEmailDomain(domain) {
  const value = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!value || value.includes('@')) {
    throw new Error(`invalid email domain: ${JSON.stringify(domain)}`);
  }
  return value;
}

export async function initRealms(cfg) {
  await closeRealms();

  dialect = cfg.database.dialect;
  realmsPath = path.resolve(cfg.database.realms);
  const systemPath = path.resolve(cfg.database.path);

  fs.mkdirSync(realmsPath, { recursive: true });
  fs.mkdirSync(path.dirname(systemPath), { recursive: true });

  systemDb = await openDatabase({ dialect, path: systemPath });
  await migrateSystem(systemDb);
}

export async function closeRealms() {
  for (const db of realmDbs.values()) {
    await db.close();
  }
  realmDbs.clear();

  if (systemDb) {
    await systemDb.close();
    systemDb = null;
  }
}

export function getSystemDatabase() {
  if (!systemDb) throw new Error('realm registry is not initialized');
  return systemDb;
}

export async function openRealmDatabase(realm) {
  const cached = realmDbs.get(realm.id);
  if (cached) return cached;

  const fullPath = path.resolve(realmsPath, realm.db_file);
  if (path.dirname(fullPath) !== realmsPath) {
    throw new HttpError(404, 'unknown_realm', 'Unknown realm');
  }
  if (!fs.existsSync(fullPath)) {
    throw new HttpError(404, 'unknown_realm', 'Unknown realm');
  }

  const db = await openDatabase({ dialect, path: fullPath });
  await migrateRealm(db, `realm ${realm.slug}`);
  await seedRealmDefaults(db);
  realmDbs.set(realm.id, db);
  return db;
}

export async function realmMetadata(realm) {
  const db = await openRealmDatabase(realm);
  const settings = await db.get(
    `SELECT slug, display_name, status, branding, allow_session_duration_choice
       FROM realm_settings
      WHERE id = 1`
  );

  if (!settings || settings.status !== 'active') {
    throw new HttpError(404, 'unknown_realm', 'Unknown realm');
  }

  return {
    slug: settings.slug,
    display_name: settings.display_name,
    branding: parseBranding(settings.branding),
    allow_session_duration_choice: Boolean(settings.allow_session_duration_choice),
  };
}

export async function resolveRealm({ host, slug } = {}) {
  if (!systemDb) throw new Error('realm registry is not initialized');

  const normalizedHost = normalizeHost(host);
  if (normalizedHost) {
    const byClientHost = await systemDb.get(
      `SELECT r.id, r.slug, r.db_file, r.owner_user_id
         FROM oidc_client_hosts h
         JOIN realms r ON r.id = h.realm_id
        WHERE h.host = {host}`,
      { host: normalizedHost }
    );
    if (byClientHost) {
      if (slug && slug !== byClientHost.slug) {
        throw new HttpError(404, 'unknown_realm', 'Unknown realm');
      }
      return byClientHost;
    }

    const byHost = await systemDb.get(
      `SELECT r.id, r.slug, r.db_file, r.owner_user_id
         FROM realm_hosts h
         JOIN realms r ON r.id = h.realm_id
        WHERE h.host = {host}`,
      { host: normalizedHost }
    );
    if (byHost) {
      if (slug && slug !== byHost.slug) {
        throw new HttpError(404, 'unknown_realm', 'Unknown realm');
      }
      return byHost;
    }
  }

  if (slug) {
    const bySlug = await systemDb.get(
      'SELECT id, slug, db_file, owner_user_id FROM realms WHERE slug = {slug}',
      { slug }
    );
    if (bySlug) return bySlug;
  }

  throw new HttpError(404, 'unknown_realm', 'Unknown realm');
}

export async function createRealm({
  slug,
  displayName,
  branding = {},
  hosts = [],
  ownerUserId = null,
  allowSessionDurationChoice = true,
}) {
  if (!systemDb) throw new Error('realm registry is not initialized');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug || '')) {
    throw new Error(`invalid realm slug: ${JSON.stringify(slug)}`);
  }

  const existing = await systemDb.get('SELECT id FROM realms WHERE slug = {slug}', { slug });
  if (existing) throw new Error(`realm already exists: ${slug}`);

  const id = crypto.randomUUID();
  const dbFile = `${id}.sqlite`;
  const fullPath = path.join(realmsPath, dbFile);

  const db = await openDatabase({ dialect, path: fullPath });
  try {
    await migrateRealm(db, `realm ${slug}`);
    await writeRealmSettings(db, {
      slug,
      displayName,
      kind: 'realm',
      branding,
      allowSessionDurationChoice,
    });
    await seedRealmDefaults(db);
  } catch (e) {
    await db.close();
    fs.rmSync(fullPath, { force: true });
    throw e;
  }

  try {
    await systemDb.run(
      `INSERT INTO realms (id, slug, db_file, owner_user_id, created_at)
       VALUES ({id}, {slug}, {dbFile}, {ownerUserId}, {createdAt})`,
      { id, slug, dbFile, ownerUserId, createdAt: Date.now() }
    );

    for (const host of hosts) {
      await addRealmHost(id, host);
    }
  } catch (e) {
    await systemDb.run('DELETE FROM realms WHERE id = {id}', { id });
    await db.close();
    fs.rmSync(fullPath, { force: true });
    throw e;
  }

  realmDbs.set(id, db);
  return { id, slug, db_file: dbFile, owner_user_id: ownerUserId };
}

export async function addRealmHost(realmId, host) {
  if (!systemDb) throw new Error('realm registry is not initialized');
  const normalized = normalizeHost(host);
  if (!normalized || normalized !== String(host).trim().toLowerCase()) {
    throw new Error(`invalid realm hostname: ${JSON.stringify(host)}`);
  }
  await systemDb.run(
    'INSERT INTO realm_hosts (host, realm_id, created_at) VALUES ({host}, {realmId}, {createdAt})',
    { host: normalized, realmId, createdAt: Date.now() }
  );
}

export async function addOidcClientHost(realmId, clientId, host) {
  if (!systemDb) throw new Error('realm registry is not initialized');
  const normalized = normalizeHost(host);
  if (!normalized || normalized !== String(host).trim().toLowerCase()) {
    throw new Error(`invalid client hostname: ${JSON.stringify(host)}`);
  }
  await systemDb.run(
    `INSERT INTO oidc_client_hosts (host, realm_id, client_id, created_at)
     VALUES ({host}, {realmId}, {clientId}, {createdAt})`,
    { host: normalized, realmId, clientId, createdAt: Date.now() }
  );
}

export async function findOidcClientHost(host) {
  if (!systemDb) throw new Error('realm registry is not initialized');
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  return systemDb.get(
    `SELECT h.host, h.realm_id, h.client_id, r.slug, r.db_file, r.owner_user_id
       FROM oidc_client_hosts h
       JOIN realms r ON r.id = h.realm_id
      WHERE h.host = {host}`,
    { host: normalized }
  );
}

export async function findRealmHost(host) {
  if (!systemDb) throw new Error('realm registry is not initialized');
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  return systemDb.get(
    `SELECT r.id, r.slug, r.db_file, r.owner_user_id
       FROM realm_hosts h
       JOIN realms r ON r.id = h.realm_id
      WHERE h.host = {host}`,
    { host: normalized }
  );
}

export async function addRealmEmailDomain(realmId, domain, { verified = true } = {}) {
  if (!systemDb) throw new Error('realm registry is not initialized');
  const normalized = normalizeEmailDomain(domain);
  const existing = await systemDb.get(
    'SELECT domain FROM realm_email_domains WHERE domain = {domain}',
    { domain: normalized }
  );
  if (existing) throw new Error(`email domain is already assigned: ${normalized}`);
  const now = Date.now();
  await systemDb.run(
    `INSERT INTO realm_email_domains
      (domain, realm_id, verified, verification_token, verified_at, created_at)
     VALUES
      ({domain}, {realmId}, {verified}, {token}, {verifiedAt}, {createdAt})`,
    {
      domain: normalized,
      realmId,
      verified: verified ? 1 : 0,
      token: verified ? null : crypto.randomBytes(24).toString('base64url'),
      verifiedAt: verified ? now : null,
      createdAt: now,
    }
  );
}

export async function findRealmByEmailDomain(domain) {
  if (!systemDb) throw new Error('realm registry is not initialized');
  const normalized = normalizeEmailDomain(domain);
  return systemDb.get(
    `SELECT r.id, r.slug, r.db_file, r.owner_user_id
       FROM realm_email_domains d
       JOIN realms r ON r.id = d.realm_id
      WHERE d.domain = {domain} AND d.verified = 1`,
    { domain: normalized }
  );
}

export async function findRealmBySlug(slug) {
  if (!systemDb) throw new Error('realm registry is not initialized');
  return systemDb.get(
    'SELECT id, slug, db_file, owner_user_id FROM realms WHERE slug = {slug}',
    { slug }
  );
}

export async function findRealmById(id) {
  if (!systemDb) throw new Error('realm registry is not initialized');
  return systemDb.get(
    'SELECT id, slug, db_file, owner_user_id FROM realms WHERE id = {id}',
    { id }
  );
}
