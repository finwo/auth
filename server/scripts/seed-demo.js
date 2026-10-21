import crypto from 'node:crypto';
import { loadConfig } from '../src/lib/config.js';
import { hashPassword } from '../src/lib/password.js';
import { hashClientSecret } from '../src/lib/oidc/clients.js';
import {
  addClientRealm,
  addOidcClientHost,
  addRealmEmailDomain,
  closeRealms,
  createRealm,
  findClientRealm,
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
  setSystemAdmin,
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

async function ensureUser({
  username,
  email,
  displayName,
  password = DEMO_PASSWORD,
  isSystemAdmin = false,
}) {
  const systemDb = getSystemDatabase();
  const existing =
    (await findUserByEmail(systemDb, email)) || (await findUserByUsername(systemDb, username));
  if (existing) {
    await setPasswordCredential(systemDb, existing.id, await hashPassword(password));
    if (isSystemAdmin) await setSystemAdmin(systemDb, existing.id, true);
    return existing.id;
  }

  const id = await createUser(systemDb, { username, displayName, isSystemAdmin });
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

async function ensureClient(
  realm,
  db,
  {
    clientId,
    name,
    accessMode,
    roles = [],
    redirectUris = [],
    postLogoutRedirectUris = [],
    tokenEndpointAuthMethod = 'none',
    clientSecret = null,
    branding = {},
    requirePkce = true,
  }
) {
  const mapping = await findClientRealm(clientId);
  if (mapping && mapping.realm_id !== realm.id) {
    throw new Error(`client id is already assigned: ${clientId}`);
  }

  let client = await db.get('SELECT id FROM oidc_clients WHERE client_id = {clientId}', { clientId });
  if (!client) {
    const now = Date.now();
    client = { id: crypto.randomUUID() };
    await db.run(
      `INSERT INTO oidc_clients
        (id, client_id, name, redirect_uris, scopes, access_mode, enabled, branding,
         client_secret_hash, token_endpoint_auth_method, require_pkce,
         post_logout_redirect_uris, created_at, updated_at)
       VALUES
        ({id}, {clientId}, {name}, {redirectUris}, 'openid profile email', {accessMode}, 1, {branding},
         {clientSecretHash}, {tokenEndpointAuthMethod}, {requirePkce},
         {postLogoutRedirectUris}, {createdAt}, {updatedAt})`,
      {
        id: client.id,
        clientId,
        name,
        redirectUris: JSON.stringify(redirectUris),
        accessMode,
        branding: JSON.stringify(branding),
        clientSecretHash: clientSecret ? hashClientSecret(clientSecret) : null,
        tokenEndpointAuthMethod,
        requirePkce: requirePkce ? 1 : 0,
        postLogoutRedirectUris: JSON.stringify(postLogoutRedirectUris),
        createdAt: now,
        updatedAt: now,
      }
    );
  }

  await addClientRealm(clientId, realm.id);

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
const publicUrl = new URL(cfg.server.public_url);
const portSuffix = publicUrl.port ? `:${publicUrl.port}` : '';
const clientOrigin = (host) => `${publicUrl.protocol}//${host}${portSuffix}`;

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

await ensureRealmDomain(acme.id, 'acme.test');
await ensureRealmDomain(acme.id, 'sso.acme.test');
await ensureRealmDomain(globex.id, 'globex.test');

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
  isSystemAdmin: true,
});

await ensureRealmUser('acme', alice);
await ensureRealmUser('globex', alice);
await ensureRealmUser('acme', acmeAdmin, ['realm-admin']);
await ensureRealmUser('acme', guest);
await ensureRealmUser('globex', contractor, ['realm-admin']);

const acmeDb = await openRealmDatabase(acme);
const providerId = await ensureProvider(acmeDb, {
  slug: 'example-sso',
  displayName: 'Example SSO',
  issuer: 'https://idp.example.com',
  clientId: 'demo',
  clientSecret: 'demo-secret',
});
await ensureProviderDomain(acmeDb, 'sso.acme.test', providerId);

await ensureClient(acme, acmeDb, {
  clientId: 'internal-app',
  name: 'Internal App',
  accessMode: 'internal',
  redirectUris: [`${clientOrigin('app.acme.localhost')}/callback`],
  postLogoutRedirectUris: [`${clientOrigin('app.acme.localhost')}/`],
});
await ensureClient(acme, acmeDb, {
  clientId: 'acme-members-app',
  name: 'Acme Members App',
  accessMode: 'members',
  redirectUris: [`${clientOrigin('members.localhost')}/callback`],
});
await ensureClient(acme, acmeDb, {
  clientId: 'acme-public-app',
  name: 'Acme Public App',
  accessMode: 'public',
  redirectUris: [`${clientOrigin('public.localhost')}/callback`],
});
await ensureClient(acme, acmeDb, {
  clientId: 'confidential-app',
  name: 'Confidential App',
  accessMode: 'members',
  redirectUris: [`${clientOrigin('confidential.localhost')}/callback`],
  tokenEndpointAuthMethod: 'client_secret_basic',
  clientSecret: 'demo-secret',
});

const globexDb = await openRealmDatabase(globex);
await ensureClient(globex, globexDb, {
  clientId: 'globex-members-app',
  name: 'Globex Members App',
  accessMode: 'members',
  redirectUris: [`${clientOrigin('members.localhost')}/callback`],
});
await ensureClient(globex, globexDb, {
  clientId: 'globex-public-app',
  name: 'Globex Public App',
  accessMode: 'public',
  redirectUris: [`${clientOrigin('public.localhost')}/callback`],
});

await addOidcClientHost('internal-app', 'app.acme.localhost');

console.log('seeded realms acme and globex');
console.log('password for all demo users: demo');
console.log('home users: alice@acme.test, it@acme.test, admin@system.test (system admin)');
console.log('guest users: guest@personal.test (acme), contractor@personal.test (globex realm-admin)');
console.log('upstream mapping: sso.acme.test -> Example SSO');
console.log(
  'clients: internal-app, acme-members-app, acme-public-app, confidential-app, ' +
    'globex-members-app, globex-public-app'
);
console.log('client host: app.acme.localhost -> acme/internal-app');
console.log('built-in system clients: admin, account');

await closeRealms();
