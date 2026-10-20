import crypto from 'node:crypto';
import { loadConfig } from '../src/lib/config.js';
import { hashPassword } from '../src/lib/password.js';
import {
  addRealmEmailDomain,
  closeRealms,
  createRealm,
  findRealmBySlug,
  getSystemDatabase,
  initRealms,
  openRealmDatabase,
} from '../src/lib/realm.js';
import {
  addUserEmail,
  assignHomeRealmForEmail,
  assignRole,
  createUser,
  ensureMembership,
  findUserByEmail,
  findUserByUsername,
  setPasswordCredential,
} from '../src/lib/users.js';

const DEMO_PASSWORD = 'demo';

async function ensureRealm({ slug, displayName, hosts, branding, allowSessionDurationChoice = true }) {
  let realm = await findRealmBySlug(slug);
  if (!realm) {
    realm = await createRealm({
      slug,
      displayName,
      hosts,
      branding,
      allowSessionDurationChoice,
    });
  }
  return realm;
}

async function ensureRealmDomain(realmId, domain) {
  const systemDb = getSystemDatabase();
  const existing = await systemDb.get(
    'SELECT realm_id FROM realm_email_domains WHERE domain = {domain}',
    { domain }
  );
  if (existing) return;
  await addRealmEmailDomain(realmId, domain, { verified: true });
}

async function ensureRealmUser(realmSlug, userId, roles = []) {
  const realm = await findRealmBySlug(realmSlug);
  if (!realm) throw new Error(`unknown realm: ${realmSlug}`);
  const db = await openRealmDatabase(realm);
  await ensureMembership(db, userId, 'active');
  for (const role of roles) {
    await assignRole(db, userId, role);
  }
}

async function ensureUser({ username, email, displayName, password = DEMO_PASSWORD }) {
  const systemDb = getSystemDatabase();
  const existing =
    (await findUserByEmail(systemDb, email)) || (await findUserByUsername(systemDb, username));
  if (existing) {
    await setPasswordCredential(systemDb, existing.id, await hashPassword(password));
    return existing.id;
  }

  const id = await createUser(systemDb, { username, displayName });
  await addUserEmail(systemDb, id, email, { verified: true, primary: true });
  await assignHomeRealmForEmail(systemDb, id, email);
  await setPasswordCredential(systemDb, id, await hashPassword(password));
  return id;
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

async function ensureProviderDomain(db, domain, providerId) {
  const existing = await db.get('SELECT domain FROM email_domain_providers WHERE domain = {domain}', {
    domain,
  });
  if (existing) return;
  await db.run(
    'INSERT INTO email_domain_providers (domain, provider_id, created_at) VALUES ({domain}, {providerId}, {createdAt})',
    { domain, providerId, createdAt: Date.now() }
  );
}

async function ensureClient(db, { clientId, name, accessMode, roles = [] }) {
  let client = await db.get('SELECT id FROM oidc_clients WHERE client_id = {clientId}', { clientId });
  if (!client) {
    const now = Date.now();
    client = { id: crypto.randomUUID() };
    await db.run(
      `INSERT INTO oidc_clients
        (id, client_id, name, redirect_uris, scopes, access_mode, enabled, created_at, updated_at)
       VALUES
        ({id}, {clientId}, {name}, '[]', 'openid profile email', {accessMode}, 1, {createdAt}, {updatedAt})`,
      {
        id: client.id,
        clientId,
        name,
        accessMode,
        createdAt: now,
        updatedAt: now,
      }
    );
  }

  for (const slug of roles) {
    const role = await db.get('SELECT id FROM roles WHERE slug = {slug}', { slug });
    if (!role) continue;
    const existing = await db.get(
      'SELECT client_id FROM oidc_client_roles WHERE client_id = {clientId} AND role_id = {roleId}',
      { clientId: client.id, roleId: role.id }
    );
    if (existing) continue;
    await db.run(
      'INSERT INTO oidc_client_roles (client_id, role_id) VALUES ({clientId}, {roleId})',
      { clientId: client.id, roleId: role.id }
    );
  }
}

const cfg = loadConfig();
await initRealms(cfg);

const acme = await ensureRealm({
  slug: 'acme',
  displayName: 'Acme',
  hosts: ['acme.localhost'],
  branding: { primary_color: '#25A' },
});
const globex = await ensureRealm({
  slug: 'globex',
  displayName: 'Globex',
  hosts: ['globex.localhost'],
  branding: { primary_color: '#25A' },
});
const system = await findRealmBySlug('system');

await ensureRealmDomain(acme.id, 'acme.test');
await ensureRealmDomain(acme.id, 'sso.acme.test');
await ensureRealmDomain(globex.id, 'globex.test');
await ensureRealmDomain(system.id, 'system.test');

const alice = await ensureUser({
  username: 'alice',
  email: 'alice@acme.test',
  displayName: 'Alice',
});
const acmeAdmin = await ensureUser({
  username: 'acme-it',
  email: 'it@acme.test',
  displayName: 'Acme IT',
});
const guest = await ensureUser({
  username: 'guest',
  email: 'guest@personal.test',
  displayName: 'Guest User',
});
const contractor = await ensureUser({
  username: 'contractor',
  email: 'contractor@personal.test',
  displayName: 'Contractor',
});
const systemAdmin = await ensureUser({
  username: 'admin',
  email: 'admin@system.test',
  displayName: 'System Admin',
});

await ensureRealmUser('acme', alice);
await ensureRealmUser('globex', alice);
await ensureRealmUser('acme', acmeAdmin, ['realm-admin']);
await ensureRealmUser('acme', guest);
await ensureRealmUser('globex', contractor, ['realm-admin']);
await ensureRealmUser('system', systemAdmin, ['system-admin']);

const acmeDb = await openRealmDatabase(acme);
const providerId = await ensureProvider(acmeDb, {
  slug: 'example-sso',
  displayName: 'Example SSO',
  issuer: 'https://idp.example.com',
  clientId: 'demo',
  clientSecret: 'demo-secret',
});
await ensureProviderDomain(acmeDb, 'sso.acme.test', providerId);

await ensureClient(acmeDb, { clientId: 'internal-app', name: 'Internal App', accessMode: 'internal' });
await ensureClient(acmeDb, { clientId: 'members-app', name: 'Members App', accessMode: 'members' });
await ensureClient(acmeDb, { clientId: 'public-app', name: 'Public App', accessMode: 'public' });

console.log('seeded realms acme, globex and system');
console.log('password for all demo users: demo');
console.log('home users: alice@acme.test, it@acme.test, admin@system.test');
console.log('guest users: guest@personal.test (acme), contractor@personal.test (globex realm-admin)');
console.log('upstream mapping: sso.acme.test -> Example SSO');
console.log('clients: admin-ui, internal-app, members-app, public-app');

await closeRealms();
