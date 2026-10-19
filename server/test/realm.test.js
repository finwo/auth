import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveLogin } from '../src/lib/login.js';
import {
  closeRealms,
  createRealm,
  initRealms,
  openRealmDatabase,
  realmMetadata,
  resolveRealm,
} from '../src/lib/realm.js';

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
    assert.deepEqual(metadata.branding, {});
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('identifier resolution selects password, upstream provider or a disabled provider', async () => {
  const { dir, cfg } = await tempConfig();
  try {
    await initRealms(cfg);
    const realm = await createRealm({ slug: 'acme', displayName: 'Acme' });
    const db = await openRealmDatabase(realm);

    const local = await resolveLogin(db, 'alice@local.test');
    assert.equal(local.next, 'password');
    const username = await resolveLogin(db, 'alice');
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
      'INSERT INTO email_domains (domain, provider_id, created_at) VALUES ({domain}, {providerId}, {now})',
      { domain: 'example.com', providerId, now }
    );

    const upstream = await resolveLogin(db, 'someone@example.com');
    assert.equal(upstream.next, 'oidc');
    assert.equal(upstream.provider.display_name, 'Example SSO');

    await db.run('UPDATE identity_providers SET enabled = 0 WHERE id = {id}', { id: providerId });
    await assert.rejects(() => resolveLogin(db, 'someone@example.com'), /unavailable/);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
