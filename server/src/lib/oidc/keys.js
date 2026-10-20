import crypto from 'node:crypto';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
} from 'jose';

const pending = new WeakMap();

async function loadSigningKey(db) {
  const row = await db.get(
    `SELECT id, alg, private_jwk, public_jwk
       FROM signing_keys
      WHERE status = 'active'
      ORDER BY created_at DESC
      LIMIT 1`
  );
  if (row) {
    return {
      id: row.id,
      alg: row.alg,
      privateJwk: JSON.parse(row.private_jwk),
      publicJwk: JSON.parse(row.public_jwk),
    };
  }

  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const id = crypto.randomUUID();
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);

  privateJwk.kid = id;
  privateJwk.alg = 'ES256';
  privateJwk.use = 'sig';
  publicJwk.kid = id;
  publicJwk.alg = 'ES256';
  publicJwk.use = 'sig';

  await db.run(
    `INSERT INTO signing_keys (id, alg, private_jwk, public_jwk, status, created_at)
     VALUES ({id}, 'ES256', {privateJwk}, {publicJwk}, 'active', {createdAt})`,
    {
      id,
      privateJwk: JSON.stringify(privateJwk),
      publicJwk: JSON.stringify(publicJwk),
      createdAt: Date.now(),
    }
  );

  return { id, alg: 'ES256', privateJwk, publicJwk };
}

export function ensureSigningKey(db) {
  let promise = pending.get(db);
  if (!promise) {
    promise = loadSigningKey(db);
    pending.set(db, promise);
  }
  return promise;
}

export async function getJwks(db) {
  const key = await ensureSigningKey(db);
  return { keys: [key.publicJwk] };
}

export async function signToken(db, claims, { issuer, audience, expiresIn }) {
  const key = await ensureSigningKey(db);
  const privateKey = await importJWK(key.privateJwk, key.alg);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT(claims)
    .setProtectedHeader({ alg: key.alg, kid: key.id, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(privateKey);
}

export async function verifyToken(db, token, { issuer, audience }) {
  const key = await ensureSigningKey(db);
  const publicKey = await importJWK(key.publicJwk, key.alg);
  const { payload } = await jwtVerify(token, publicKey, { issuer, audience });
  return payload;
}
