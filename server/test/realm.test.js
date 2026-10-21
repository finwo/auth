import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findManagedProviderForUser, resolveLogin } from '../src/lib/login.js';
import {
  addClientRealm,
  addOidcClientHost,
  addRealmEmailDomain,
  closeRealms,
  createRealm,
  findClientRealm,
  findOidcClientHost,
  findRealmByEmailDomain,
  getSystemDatabase,
  initRealms,
  openRealmDatabase,
  realmMetadata,
  resolveRealm,
} from '../src/lib/realm.js';
import {
  addUserEmail,
  assignHomeRealmForEmail,
  createUser,
  findUserById,
} from '../src/lib/users.js';

async function tempConfig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-realm-'));
  return {
    dir,
    cfg: {
      database: {
        dialect: 'sqlite',
        path: path.join(dir, 'system.sqlite'),
        realms: path.join(dir, 'realms'),
      },
    },
  };
}

test('realm resolution prefers hostname and rejects a mismatched slug', async () => {
  const { dir, cfg } = await tempConfig();
  try {
    await initRealms(cfg);
    await createRealm({ slug: 'acme', displayName: 'Acme', hosts: ['acme.localhost'] });

    const byHost = await resolveRealm({ host: 'acme.localhost' });
    assert.equal(byHost.slug, 'acme');

    const bySlug = await resolveRealm({ host: 'main.test:3000', slug: 'acme' });
    assert.equal(bySlug.slug, 'acme');

    await assert.rejects(
      () => resolveRealm({ host: 'acme.localhost', slug: 'system' }),
      /Unknown realm/
    );
    await assert.rejects(() => resolveRealm({ host: 'main.test:3000', slug: 'nope' }), /Unknown realm/);

    const metadata = await realmMetadata(byHost);
    assert.equal(metadata.display_name, 'Acme');
    assert.equal(metadata.allow_session_duration_choice, true);
    assert.deepEqual(metadata.branding, {});
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('client IDs are globally unique and client hosts resolve through mappings', async () => {
  const { dir, cfg } = await tempConfig();
  try {
    await initRealms(cfg);
    const acme = await createRealm({ slug: 'acme', displayName: 'Acme' });
    const globex = await createRealm({ slug: 'globex', displayName: 'Globex' });

    await addClientRealm('shared-app', acme.id);
    const mapping = await findClientRealm('shared-app');
    assert.equal(mapping.realm_id, acme.id);
    assert.equal(mapping.slug, 'acme');

    await assert.rejects(
      () => addClientRealm('shared-app', globex.id),
      /already assigned/
    );
    await assert.rejects(() => addClientRealm('Bad App', acme.id), /invalid client id/);
    await assert.rejects(() => addClientRealm('admin', acme.id), /reserved/);
    await assert.rejects(() => addClientRealm('account', acme.id), /reserved/);

    await addOidcClientHost('shared-app', 'app.acme.localhost');
    const clientHost = await findOidcClientHost('app.acme.localhost:3000');
    assert.equal(clientHost.client_id, 'shared-app');
    assert.equal(clientHost.realm_id, acme.id);
    assert.equal(clientHost.slug, 'acme');

    const realm = await resolveRealm({ host: 'app.acme.localhost' });
    assert.equal(realm.id, acme.id);

    await assert.rejects(
      () => addOidcClientHost('missing-app', 'app.missing.localhost'),
      /unknown client/
    );
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('owned email domains select their realm provider mapping', async () => {
  const { dir, cfg } = await tempConfig();
  try {
    await initRealms(cfg);
    const realm = await createRealm({ slug: 'acme', displayName: 'Acme' });
    await addRealmEmailDomain(realm.id, 'example.com', { verified: true });
    const db = await openRealmDatabase(realm);

    const local = await resolveLogin({ identifier: 'alice@local.test' });
    assert.equal(local.next, 'password');
    const username = await resolveLogin({ identifier: 'alice' });
    assert.equal(username.next, 'password');

    const providerId = crypto.randomUUID();
    const now = Date.now();
    await db.run(
      `INSERT INTO identity_providers
        (id, slug, display_name, issuer, client_id, client_secret, scopes, enabled, created_at, updated_at)
       VALUES
        ({id}, 'example-sso', 'Example SSO', 'https://idp.example.com', 'demo', NULL, 'openid email profile', 1, {now}, {now})`,
      { id: providerId, now }
    );
    await db.run(
      'INSERT INTO email_domain_providers (domain, provider_id, created_at) VALUES ({domain}, {providerId}, {now})',
      { domain: 'example.com', providerId, now }
    );

    const owner = await findRealmByEmailDomain('example.com');
    assert.equal(owner.id, realm.id);

    const upstream = await resolveLogin({ identifier: 'someone@example.com' });
    assert.equal(upstream.next, 'oidc');
    assert.equal(upstream.provider.display_name, 'Example SSO');

    const systemDb = getSystemDatabase();
    const userId = await createUser(systemDb, { username: 'someone' });
    await addUserEmail(systemDb, userId, 'someone@example.com', { verified: true, primary: true });
    await assignHomeRealmForEmail(systemDb, userId, 'someone@example.com');
    const user = await findUserById(systemDb, userId);
    assert.equal(user.home_realm_id, realm.id);

    const managed = await findManagedProviderForUser(systemDb, user);
    assert.equal(managed.display_name, 'Example SSO');

    await db.run('UPDATE identity_providers SET enabled = 0 WHERE id = {id}', { id: providerId });
    await assert.rejects(() => resolveLogin({ identifier: 'someone@example.com' }), /unavailable/);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a realm can disable the long-session choice', async () => {
  const { dir, cfg } = await tempConfig();
  try {
    await initRealms(cfg);
    const realm = await createRealm({
      slug: 'acme',
      displayName: 'Acme',
      allowSessionDurationChoice: false,
    });
    const metadata = await realmMetadata(realm);
    assert.equal(metadata.allow_session_duration_choice, false);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
