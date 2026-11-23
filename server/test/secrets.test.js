import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealm, closeRealms, initRealms, openRealmDatabase } from '../src/lib/realm.js';
import {
  createAdminRealmProvider,
  normalizeCreateProviderInput,
  normalizeUpdateProviderInput,
  updateAdminRealmProvider,
} from '../src/lib/admin-realm-providers.js';
import {
  decryptSecret,
  encryptSecret,
  hasSecretKey,
  isEncrypted,
  migrateProviderSecrets,
  parseSecretKey,
} from '../src/lib/secrets.js';

const KEY_A = 'ab'.repeat(32);
const KEY_B = 'cd'.repeat(32);
const KEY_BASE64 = Buffer.from('ab'.repeat(32), 'hex').toString('base64');
const CONTEXT = { realmId: 'realm-1', providerId: 'provider-1' };

function useKey(value) {
  if (value === null) {
    delete process.env.AUTH_SECRETS_KEY;
  } else {
    process.env.AUTH_SECRETS_KEY = value;
  }
}

async function tempRegistry(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-secrets-'));
  try {
    const cfg = {
      database: {
        dialect: 'sqlite',
        path: path.join(dir, 'system.sqlite'),
        realms: path.join(dir, 'realms'),
      },
    };
    await initRealms(cfg);
    await fn();
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function insertProvider(db, { id, slug, clientSecret }) {
  await db.run(
    `INSERT INTO identity_providers
      (id, slug, display_name, issuer, client_id, client_secret, scopes, enabled, created_at, updated_at)
     VALUES
      ({id}, {slug}, {displayName}, {issuer}, {clientId}, {clientSecret}, 'openid', 1, {now}, {now})`,
    {
      id,
      slug,
      displayName: `Provider ${slug}`,
      issuer: 'https://idp.test',
      clientId: 'cid',
      clientSecret,
      now: Date.now(),
    }
  );
}

async function readProviderSecret(db, slug) {
  const row = await db.get('SELECT client_secret FROM identity_providers WHERE slug = {slug}', {
    slug,
  });
  return row.client_secret;
}

test('parseSecretKey accepts hex and base64 32-byte keys', () => {
  assert.equal(parseSecretKey(KEY_A).length, 32);
  assert.deepEqual(parseSecretKey(KEY_A), parseSecretKey(KEY_BASE64));
  assert.throws(() => parseSecretKey('short'), /32 bytes/);
  assert.throws(() => parseSecretKey('ab'.repeat(31) + 'zz'), /32 bytes/);
  assert.throws(() => parseSecretKey(''), /empty/);
});

test('encryptSecret roundtrips with a versioned prefix and random IV', () => {
  useKey(KEY_A);
  try {
    const a = encryptSecret('hunter2', CONTEXT);
    const b = encryptSecret('hunter2', CONTEXT);
    assert.ok(a.startsWith('enc:v1:'));
    assert.ok(!a.includes('hunter2'));
    assert.notEqual(a, b, 'random IV produces distinct ciphertexts');
    assert.equal(decryptSecret(a, CONTEXT), 'hunter2');
    assert.equal(decryptSecret('plain-value', CONTEXT), 'plain-value');
    assert.equal(decryptSecret(null, CONTEXT), null);
    assert.equal(decryptSecret('', CONTEXT), null);
    assert.equal(isEncrypted(a), true);
    assert.equal(isEncrypted('plain-value'), false);
    assert.equal(hasSecretKey(), true);
  } finally {
    useKey(null);
  }
});

test('decryptSecret rejects tampering, context mismatch, and wrong keys', () => {
  useKey(KEY_A);
  try {
    const stored = encryptSecret('hunter2', CONTEXT);

    const tamperedChar = stored[stored.length - 2] === 'A' ? 'B' : 'A';
    const tampered =
      stored.slice(0, stored.length - 2) + tamperedChar + stored.slice(stored.length - 1);

    const failures = [
      () => decryptSecret(tampered, CONTEXT),
      () => decryptSecret(stored, { ...CONTEXT, realmId: 'realm-2' }),
      () => decryptSecret(stored, { ...CONTEXT, providerId: 'provider-2' }),
      () => decryptSecret('enc:v1:not valid base64url payload', CONTEXT),
    ];
    for (const run of failures) {
      assert.throws(run, (e) => e.status === 500 && e.code === 'secret_decrypt_failed');
    }

    useKey(KEY_B);
    assert.throws(
      () => decryptSecret(stored, CONTEXT),
      (e) => e.status === 500 && e.code === 'secret_decrypt_failed'
    );
  } finally {
    useKey(null);
  }
});

test('secret storage is unavailable without a key', () => {
  useKey(null);
  assert.equal(hasSecretKey(), false);
  assert.throws(
    () => encryptSecret('hunter2', CONTEXT),
    (e) => e.status === 503 && e.code === 'secret_storage_unavailable'
  );
  assert.throws(
    () => decryptSecret(`enc:v1:${Buffer.alloc(40).toString('base64url')}`, CONTEXT),
    (e) => e.status === 500 && e.code === 'secret_decrypt_failed'
  );
});

test('migrateProviderSecrets encrypts plaintext rows across realms once', async () => {
  useKey(KEY_A);
  try {
    await tempRegistry(async () => {
      const alpha = await createRealm({ slug: 'alpha', displayName: 'Alpha' });
      const beta = await createRealm({ slug: 'beta', displayName: 'Beta' });
      const alphaDb = await openRealmDatabase(alpha);
      const betaDb = await openRealmDatabase(beta);

      await insertProvider(alphaDb, {
        id: crypto.randomUUID(),
        slug: 'plain',
        clientSecret: 's3cret',
      });
      await insertProvider(alphaDb, {
        id: crypto.randomUUID(),
        slug: 'none',
        clientSecret: null,
      });
      await insertProvider(betaDb, {
        id: crypto.randomUUID(),
        slug: 'plain',
        clientSecret: 'other',
      });

      assert.equal(await migrateProviderSecrets(), 2);

      const alphaRow = await alphaDb.get(
        'SELECT id FROM identity_providers WHERE slug = {slug}',
        { slug: 'plain' }
      );
      const alphaStored = await readProviderSecret(alphaDb, 'plain');
      assert.ok(alphaStored.startsWith('enc:v1:'));
      assert.equal(
        decryptSecret(alphaStored, { realmId: alpha.id, providerId: alphaRow.id }),
        's3cret'
      );
      assert.equal(await readProviderSecret(alphaDb, 'none'), null);

      const betaRow = await betaDb.get(
        'SELECT id FROM identity_providers WHERE slug = {slug}',
        { slug: 'plain' }
      );
      const betaStored = await readProviderSecret(betaDb, 'plain');
      assert.ok(betaStored.startsWith('enc:v1:'));
      assert.equal(
        decryptSecret(betaStored, { realmId: beta.id, providerId: betaRow.id }),
        'other'
      );

      assert.equal(await migrateProviderSecrets(), 0);
    });
  } finally {
    useKey(null);
  }
});

test('migrateProviderSecrets is a no-op without a key', async () => {
  useKey(null);
  await tempRegistry(async () => {
    const alpha = await createRealm({ slug: 'alpha', displayName: 'Alpha' });
    const alphaDb = await openRealmDatabase(alpha);
    await insertProvider(alphaDb, {
      id: crypto.randomUUID(),
      slug: 'plain',
      clientSecret: 's3cret',
    });
    assert.equal(await migrateProviderSecrets(), 0);
    assert.equal(await readProviderSecret(alphaDb, 'plain'), 's3cret');
  });
});

test('provider writes encrypt at rest, upgrade legacy rows, and clear to null', async () => {
  useKey(KEY_A);
  try {
    await tempRegistry(async () => {
      const alpha = await createRealm({ slug: 'alpha', displayName: 'Alpha' });
      const db = await openRealmDatabase(alpha);

      const created = await createAdminRealmProvider({
        realmDb: db,
        realmId: alpha.id,
        input: normalizeCreateProviderInput({
          slug: 'with-secret',
          display_name: 'With Secret',
          issuer: 'https://idp.test',
          client_id: 'cid',
          client_secret: 'top-secret',
        }),
      });
      assert.equal(created.has_secret, true);
      assert.ok(!('client_secret' in created));
      const createdStored = await readProviderSecret(db, 'with-secret');
      assert.ok(createdStored.startsWith('enc:v1:'));
      assert.equal(
        decryptSecret(createdStored, { realmId: alpha.id, providerId: created.id }),
        'top-secret'
      );

      await createAdminRealmProvider({
        realmDb: db,
        realmId: alpha.id,
        input: normalizeCreateProviderInput({
          slug: 'no-secret',
          display_name: 'No Secret',
          issuer: 'https://idp.test',
          client_id: 'cid',
        }),
      });
      assert.equal(await readProviderSecret(db, 'no-secret'), null);

      await insertProvider(db, {
        id: crypto.randomUUID(),
        slug: 'legacy',
        clientSecret: 'legacy-plain',
      });
      const updated = await updateAdminRealmProvider({
        realmDb: db,
        realmId: alpha.id,
        slug: 'legacy',
        input: normalizeUpdateProviderInput({ display_name: 'Legacy 2' }),
      });
      assert.equal(updated.has_secret, true);
      const legacyStored = await readProviderSecret(db, 'legacy');
      assert.ok(legacyStored.startsWith('enc:v1:'), 'legacy plaintext upgraded on save');
      const legacyRow = await db.get('SELECT id FROM identity_providers WHERE slug = {slug}', {
        slug: 'legacy',
      });
      assert.equal(
        decryptSecret(legacyStored, { realmId: alpha.id, providerId: legacyRow.id }),
        'legacy-plain'
      );

      const cleared = await updateAdminRealmProvider({
        realmDb: db,
        realmId: alpha.id,
        slug: 'with-secret',
        input: normalizeUpdateProviderInput({ client_secret: null }),
      });
      assert.equal(cleared.has_secret, false);
      assert.equal(await readProviderSecret(db, 'with-secret'), null);
    });
  } finally {
    useKey(null);
  }
});

test('provider secret writes are rejected when no key is configured', async () => {
  useKey(null);
  await tempRegistry(async () => {
    const alpha = await createRealm({ slug: 'alpha', displayName: 'Alpha' });
    const db = await openRealmDatabase(alpha);

    await assert.rejects(
      () =>
        createAdminRealmProvider({
          realmDb: db,
          realmId: alpha.id,
          input: normalizeCreateProviderInput({
            slug: 'guarded',
            display_name: 'Guarded',
            issuer: 'https://idp.test',
            client_id: 'cid',
            client_secret: 'nope',
          }),
        }),
      (e) => e.status === 503 && e.code === 'secret_storage_unavailable'
    );

    await createAdminRealmProvider({
      realmDb: db,
      realmId: alpha.id,
      input: normalizeCreateProviderInput({
        slug: 'no-secret',
        display_name: 'No Secret',
        issuer: 'https://idp.test',
        client_id: 'cid',
      }),
    });

    await assert.rejects(
      () =>
        updateAdminRealmProvider({
          realmDb: db,
          realmId: alpha.id,
          slug: 'no-secret',
          input: normalizeUpdateProviderInput({ client_secret: 'nope' }),
        }),
      (e) => e.status === 503 && e.code === 'secret_storage_unavailable'
    );

    const kept = await updateAdminRealmProvider({
      realmDb: db,
      realmId: alpha.id,
      slug: 'no-secret',
      input: normalizeUpdateProviderInput({ display_name: 'Renamed' }),
    });
    assert.equal(kept.slug, 'no-secret');
    assert.equal(kept.display_name, 'Renamed');
  });
});
