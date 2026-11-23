import crypto from 'node:crypto';
import { app } from '../app.js';
import { HttpError } from './http/http-error.js';
import { getSystemDatabase, openRealmDatabase } from './realm.js';

const PREFIX = 'enc:v1:';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export function parseSecretKey(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    throw new Error('encryption key must not be empty');
  }
  let key;
  if (/^[0-9a-f]{64}$/i.test(value)) {
    key = Buffer.from(value, 'hex');
  } else {
    key = Buffer.from(value, 'base64');
  }
  if (key.length !== KEY_LENGTH) {
    throw new Error('encryption key must be 32 bytes (64 hex characters or base64)');
  }
  return key;
}

function configuredSecretKey() {
  const raw = app.config?.secrets?.encryption_key ?? process.env.AUTH_SECRETS_KEY ?? '';
  if (!String(raw).trim()) return null;
  return parseSecretKey(raw);
}

export function hasSecretKey() {
  return configuredSecretKey() !== null;
}

export function isEncrypted(value) {
  return String(value || '').startsWith(PREFIX);
}

export function secretStorageUnavailable() {
  return new HttpError(
    503,
    'secret_storage_unavailable',
    'A secrets encryption key must be configured to store client secrets'
  );
}

function secretAad(realmId, providerId) {
  return Buffer.from(`${realmId}:${providerId}:identity-provider-secret`, 'utf8');
}

export function encryptSecret(plaintext, { realmId, providerId }) {
  const key = configuredSecretKey();
  if (!key) {
    throw secretStorageUnavailable();
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(secretAad(realmId, providerId));
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  return `${PREFIX}${packed.toString('base64url')}`;
}

export function decryptSecret(stored, { realmId, providerId }) {
  const value = stored === null || stored === undefined ? '' : String(stored);
  if (!value) return null;
  if (!isEncrypted(value)) return value;

  const fail = () =>
    new HttpError(500, 'secret_decrypt_failed', 'The stored client secret could not be decrypted');
  const key = configuredSecretKey();
  if (!key) {
    throw fail();
  }
  try {
    const packed = Buffer.from(value.slice(PREFIX.length), 'base64url');
    const iv = packed.subarray(0, IV_LENGTH);
    const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);
    if (!iv.length || tag.length !== TAG_LENGTH || !ciphertext.length) {
      throw new Error('malformed envelope');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(secretAad(realmId, providerId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw fail();
  }
}

export async function migrateProviderSecrets() {
  const key = configuredSecretKey();
  if (!key) return 0;

  const systemDb = getSystemDatabase();
  const realms = await systemDb.all('SELECT id, slug, db_file FROM realms ORDER BY slug ASC');
  let migrated = 0;

  for (const realm of realms) {
    const db = await openRealmDatabase(realm);
    const rows = await db.all(
      `SELECT id, client_secret FROM identity_providers
        WHERE client_secret IS NOT NULL AND client_secret <> ''`
    );
    for (const row of rows) {
      if (isEncrypted(row.client_secret)) continue;
      await db.run(
        'UPDATE identity_providers SET client_secret = {value} WHERE id = {id}',
        {
          value: encryptSecret(row.client_secret, { realmId: realm.id, providerId: row.id }),
          id: row.id,
        }
      );
      migrated += 1;
    }
  }

  return migrated;
}
