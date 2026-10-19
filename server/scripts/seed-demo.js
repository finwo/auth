import crypto from 'node:crypto';
import { loadConfig } from '../src/lib/config.js';
import {
  closeRealms,
  createRealm,
  findRealmBySlug,
  getSystemDatabase,
  initRealms,
  openRealmDatabase,
} from '../src/lib/realm.js';

function normalize(input) {
  return String(input || '').trim().toLowerCase();
}

async function ensureUser(db, { username, email, displayName }) {
  const normalizedEmail = email ? normalize(email) : null;
  const existing = await db.get(
    'SELECT id FROM users WHERE username_normalized = {username}',
    { username: normalize(username) }
  );
  if (existing) return existing.id;

  const now = Date.now();
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO users
      (id, username, username_normalized, email, email_normalized, display_name, status, profile, created_at, updated_at)
     VALUES
      ({id}, {username}, {usernameNormalized}, {email}, {emailNormalized}, {displayName}, 'active', '{}', {createdAt}, {updatedAt})`,
    {
      id,
      username,
      usernameNormalized: normalize(username),
      email,
      emailNormalized: normalizedEmail,
      displayName: displayName || username,
      createdAt: now,
      updatedAt: now,
    }
  );
  return id;
}

async function grantRole(db, userId, slug) {
  const role = await db.get('SELECT id FROM roles WHERE slug = {slug}', { slug });
  if (!role) throw new Error(`missing role: ${slug}`);
  const existing = await db.get(
    'SELECT user_id FROM user_roles WHERE user_id = {userId} AND role_id = {roleId}',
    { userId, roleId: role.id }
  );
  if (existing) return;
  await db.run(
    'INSERT INTO user_roles (user_id, role_id) VALUES ({userId}, {roleId})',
    { userId, roleId: role.id }
  );
}

async function ensureProvider(db, { slug, displayName, issuer, clientId, clientSecret }) {
  const existing = await db.get('SELECT id FROM identity_providers WHERE slug = {slug}', { slug });
  if (existing) return existing.id;
  const now = Date.now();
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO identity_providers
      (id, slug, display_name, issuer, client_id, client_secret, scopes, enabled, created_at, updated_at)
     VALUES
      ({id}, {slug}, {displayName}, {issuer}, {clientId}, {clientSecret}, 'openid email profile', 1, {createdAt}, {updatedAt})`,
    {
      id,
      slug,
      displayName,
      issuer,
      clientId,
      clientSecret: clientSecret || null,
      createdAt: now,
      updatedAt: now,
    }
  );
  return id;
}

async function ensureDomain(db, domain, providerId) {
  const existing = await db.get('SELECT domain FROM email_domains WHERE domain = {domain}', {
    domain: normalize(domain),
  });
  if (existing) return;
  await db.run(
    'INSERT INTO email_domains (domain, provider_id, created_at) VALUES ({domain}, {providerId}, {createdAt})',
    { domain: normalize(domain), providerId, createdAt: Date.now() }
  );
}

const cfg = loadConfig();
await initRealms(cfg);

let acme = await findRealmBySlug('acme');
if (!acme) {
  acme = await createRealm({
    slug: 'acme',
    displayName: 'Acme',
    branding: { primary_color: '#25A' },
    hosts: ['acme.localhost'],
  });
}

const acmeDb = await openRealmDatabase(acme);
const alice = await ensureUser(acmeDb, {
  username: 'alice',
  email: 'alice@local.test',
  displayName: 'Alice',
});
const acmeAdmin = await ensureUser(acmeDb, {
  username: 'acme-it',
  email: 'it@local.test',
  displayName: 'Acme IT',
});
await grantRole(acmeDb, acmeAdmin, 'realm-admin');

const providerId = await ensureProvider(acmeDb, {
  slug: 'example-sso',
  displayName: 'Example SSO',
  issuer: 'https://idp.example.com',
  clientId: 'demo',
  clientSecret: 'demo-secret',
});
await ensureDomain(acmeDb, 'example.com', providerId);

const systemDb = getSystemDatabase();
const systemAdmin = await ensureUser(systemDb, {
  username: 'admin',
  email: 'admin@system.test',
  displayName: 'System Admin',
});
await grantRole(systemDb, systemAdmin, 'system-admin');

console.log('seeded realm acme (host acme.localhost)');
console.log('local user: alice@local.test');
console.log('upstream mapping: example.com -> Example SSO');
console.log('realm admin: it@local.test');
console.log('system admin: admin@system.test');
console.log(`alice id: ${alice}`);

await closeRealms();
