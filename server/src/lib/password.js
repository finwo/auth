import crypto from 'node:crypto';

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;
const MAX_PASSWORD_LENGTH = 1024;

function derive(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N: params.N,
        r: params.r,
        p: params.p,
        maxmem: MAX_MEMORY,
      },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      }
    );
  });
}

export async function hashPassword(password) {
  if (typeof password !== 'string') throw new Error('password must be a string');
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error('password is too long');

  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;

  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const params = {
    N: Number(parts[1]),
    r: Number(parts[2]),
    p: Number(parts[3]),
  };
  if (
    !Number.isInteger(params.N) ||
    !Number.isInteger(params.r) ||
    !Number.isInteger(params.p) ||
    params.N <= 1 ||
    params.r <= 0 ||
    params.p <= 0
  ) {
    return false;
  }

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;

  let actual;
  try {
    actual = await derive(password, salt, params);
  } catch {
    return false;
  }

  return crypto.timingSafeEqual(actual, expected);
}

let dummyHash = null;

export async function verifyDummyPassword(password) {
  if (!dummyHash) {
    dummyHash = hashPassword(crypto.randomBytes(24).toString('base64url'));
  }
  return verifyPassword(password, await dummyHash);
}
