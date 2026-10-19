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

async function migrateRealm(db) {
  return runMigrations(db, {
    dir: migrationDir(db.dialect, 'realm'),
    namespace: 'realm',
  });
}

async function migrateSystem(db) {
  await migrateRealm(db);
  return runMigrations(db, {
    dir: migrationDir(db.dialect, 'system'),
    namespace: 'system',
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
  if (existing) return;
  await db.run(
    'INSERT INTO roles (id, slug, name, created_at) VALUES ({id}, {slug}, {name}, {createdAt})',
    { id: crypto.randomUUID(), slug, name, createdAt: now }
  );
}

async function ensureAdminClient(db, now) {
  const existing = await db.get('SELECT id FROM oidc_clients WHERE client_id = {clientId}', {
    clientId: 'admin-ui',
  });
  if (existing) return;
  await db.run(
    `INSERT INTO oidc_clients
      (id, client_id, name, redirect_uris, scopes, enabled, created_at, updated_at)
     VALUES
      ({id}, {clientId}, {name}, {redirectUris}, {scopes}, 1, {createdAt}, {updatedAt})`,
    {
      id: crypto.randomUUID(),
      clientId: 'admin-ui',
      name: 'Admin UI',
      redirectUris: '[]',
      scopes: 'openid profile email',
      createdAt: now,
      updatedAt: now,
    }
  );
}

async function seedRealmDefaults(db, kind) {
  const now = Date.now();
  await ensureRole(db, 'realm-admin', 'Realm administrator', now);
  if (kind === 'system') {
    await ensureRole(db, 'system-admin', 'System administrator', now);
  }
  await ensureAdminClient(db, now);
}

async function writeRealmSettings(db, settings) {
  const now = Date.now();
  await db.run(
    `INSERT INTO realm_settings
      (id, slug, display_name, kind, status, branding, created_at, updated_at)
     VALUES
      (1, {slug}, {displayName}, {kind}, 'active', {branding}, {createdAt}, {updatedAt})`,
    {
      slug: settings.slug,
      displayName: settings.displayName,
      kind: settings.kind || 'realm',
      branding: JSON.stringify(settings.branding || {}),
      createdAt: now,
      updatedAt: now,
    }
  );
}

async function ensureSystemRealm() {
  const settings = await systemDb.get('SELECT id FROM realm_settings WHERE id = 1');
  if (!settings) {
    await writeRealmSettings(systemDb, {
      slug: 'system',
      displayName: 'System',
      kind: 'system',
    });
  }

  const registry = await systemDb.get('SELECT id FROM realms WHERE id = {id}', { id: 'system' });
  if (!registry) {
    await systemDb.run(
      'INSERT INTO realms (id, slug, db_file, created_at) VALUES ({id}, {slug}, NULL, {createdAt})',
      { id: 'system', slug: 'system', createdAt: Date.now() }
    );
  }

  await seedRealmDefaults(systemDb, 'system');

  const domains = await systemDb.get('SELECT COUNT(*) AS count FROM realm_domains');
  if (Number(domains.count) === 0) {
    const now = Date.now();
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      await systemDb.run(
        'INSERT INTO realm_domains (host, realm_id, created_at) VALUES ({host}, {realmId}, {createdAt})',
        { host, realmId: 'system', createdAt: now }
      );
    }
  }
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

export async function initRealms(cfg) {
  await closeRealms();

  dialect = cfg.database.dialect;
  realmsPath = path.resolve(cfg.database.realms);
  const systemPath = path.resolve(cfg.database.path);

  fs.mkdirSync(realmsPath, { recursive: true });
  fs.mkdirSync(path.dirname(systemPath), { recursive: true });

  systemDb = await openDatabase({ dialect, path: systemPath });
  await migrateSystem(systemDb);
  await ensureSystemRealm();
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
  if (realm.id === 'system') {
    if (!systemDb) throw new Error('realm registry is not initialized');
    return systemDb;
  }

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
  await migrateRealm(db);
  await seedRealmDefaults(db, 'realm');
  realmDbs.set(realm.id, db);
  return db;
}

export async function realmMetadata(realm) {
  const db = await openRealmDatabase(realm);
  const settings = await db.get(
    'SELECT slug, display_name, status, branding FROM realm_settings WHERE id = 1'
  );

  if (!settings || settings.status !== 'active') {
    throw new HttpError(404, 'unknown_realm', 'Unknown realm');
  }

  return {
    slug: settings.slug,
    display_name: settings.display_name,
    branding: parseBranding(settings.branding),
  };
}

export async function resolveRealm({ host, slug } = {}) {
  if (!systemDb) throw new Error('realm registry is not initialized');

  const normalizedHost = normalizeHost(host);
  if (normalizedHost) {
    const byHost = await systemDb.get(
      `SELECT r.id, r.slug, r.db_file
         FROM realm_domains d
         JOIN realms r ON r.id = d.realm_id
        WHERE d.host = {host}`,
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
      'SELECT id, slug, db_file FROM realms WHERE slug = {slug}',
      { slug }
    );
    if (bySlug) return bySlug;
  }

  throw new HttpError(404, 'unknown_realm', 'Unknown realm');
}

export async function createRealm({ slug, displayName, branding = {}, hosts = [] }) {
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
    await migrateRealm(db);
    await writeRealmSettings(db, { slug, displayName, kind: 'realm', branding });
    await seedRealmDefaults(db, 'realm');
  } catch (e) {
    await db.close();
    fs.rmSync(fullPath, { force: true });
    throw e;
  }

  try {
    await systemDb.run(
      'INSERT INTO realms (id, slug, db_file, created_at) VALUES ({id}, {slug}, {dbFile}, {createdAt})',
      { id, slug, dbFile, createdAt: Date.now() }
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
  return { id, slug, db_file: dbFile };
}

export async function addRealmHost(realmId, host) {
  if (!systemDb) throw new Error('realm registry is not initialized');
  const normalized = normalizeHost(host);
  if (!normalized || normalized !== String(host).trim().toLowerCase()) {
    throw new Error(`invalid realm hostname: ${JSON.stringify(host)}`);
  }
  await systemDb.run(
    'INSERT INTO realm_domains (host, realm_id, created_at) VALUES ({host}, {realmId}, {createdAt})',
    { host: normalized, realmId, createdAt: Date.now() }
  );
}

export async function findRealmBySlug(slug) {
  if (!systemDb) throw new Error('realm registry is not initialized');
  return systemDb.get('SELECT id, slug, db_file FROM realms WHERE slug = {slug}', { slug });
}
