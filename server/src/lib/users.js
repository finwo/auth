import crypto from 'node:crypto';
import { HttpError } from './http/http-error.js';

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

export function emailDomain(email) {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  return at > 0 && at < normalized.length - 1 ? normalized.slice(at + 1) : null;
}

export async function createUser(db, { username, displayName = null, homeRealmId = null, isSystemAdmin = false }) {
  const normalized = normalizeUsername(username);
  if (!normalized) throw new Error('username is required');
  const existing = await db.get(
    'SELECT id FROM users WHERE username_normalized = {username}',
    { username: normalized }
  );
  if (existing) throw new Error(`username is already taken: ${username}`);

  const id = crypto.randomUUID();
  const now = Date.now();
  await db.run(
    `INSERT INTO users
      (id, username, username_normalized, display_name, status, home_realm_id, is_system_admin, profile, created_at, updated_at)
     VALUES
      ({id}, {username}, {normalized}, {displayName}, 'active', {homeRealmId}, {isSystemAdmin}, '{}', {createdAt}, {updatedAt})`,
    {
      id,
      username,
      normalized,
      displayName: displayName || username,
      homeRealmId,
      isSystemAdmin: isSystemAdmin ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    }
  );
  return id;
}

export async function findUserById(db, id) {
  return db.get(
    `SELECT id, username, username_normalized, display_name, status, home_realm_id,
            is_system_admin, profile, last_login_at, created_at, updated_at
       FROM users
      WHERE id = {id}`,
    { id }
  );
}

export async function findUserByEmail(db, email) {
  const normalized = normalizeEmail(email);
  return db.get(
    `SELECT u.id, u.username, u.username_normalized, u.display_name, u.status,
            u.home_realm_id, u.is_system_admin, u.profile, u.last_login_at,
            e.email, e.email_normalized
       FROM users u
       JOIN user_emails e ON e.user_id = u.id
      WHERE e.email_normalized = {email} AND e.verified = 1`,
    { email: normalized }
  );
}

export async function findUserByUsername(db, username) {
  const normalized = normalizeUsername(username);
  return db.get(
    `SELECT id, username, username_normalized, display_name, status,
            home_realm_id, is_system_admin, profile, last_login_at
       FROM users
      WHERE username_normalized = {username}`,
    { username: normalized }
  );
}

export async function findUserByIdentifier(db, identifier) {
  const value = String(identifier || '').trim();
  return value.includes('@')
    ? findUserByEmail(db, value)
    : findUserByUsername(db, value);
}

export async function getUserEmails(db, userId) {
  return db.all(
    `SELECT id, email, email_normalized, verified, is_primary, created_at, verified_at
       FROM user_emails
      WHERE user_id = {userId}
      ORDER BY is_primary DESC, created_at ASC`,
    { userId }
  );
}

export async function getPrimaryEmail(db, userId) {
  return db.get(
    `SELECT email, email_normalized, verified
       FROM user_emails
      WHERE user_id = {userId}
      ORDER BY is_primary DESC, created_at ASC
      LIMIT 1`,
    { userId }
  );
}

export async function addUserEmail(db, userId, email, { verified = false, primary = false } = {}) {
  const normalized = normalizeEmail(email);
  const existing = await db.get(
    'SELECT user_id FROM user_emails WHERE email_normalized = {email}',
    { email: normalized }
  );
  if (existing) throw new Error(`email is already in use: ${normalized}`);

  const id = crypto.randomUUID();
  const now = Date.now();
  await db.transaction(async (tx) => {
    if (primary) {
      await tx.run('UPDATE user_emails SET is_primary = 0 WHERE user_id = {userId}', { userId });
    }
    await tx.run(
      `INSERT INTO user_emails
        (id, user_id, email, email_normalized, verified, is_primary, created_at, verified_at)
       VALUES
        ({id}, {userId}, {email}, {normalized}, {verified}, {primary}, {createdAt}, {verifiedAt})`,
      {
        id,
        userId,
        email,
        normalized,
        verified: verified ? 1 : 0,
        primary: primary ? 1 : 0,
        createdAt: now,
        verifiedAt: verified ? now : null,
      }
    );
  });
  return id;
}

export async function setPasswordCredential(db, userId, secretHash) {
  const existing = await db.get(
    'SELECT id FROM credentials WHERE user_id = {userId} AND type = {type}',
    { userId, type: 'password' }
  );
  const now = Date.now();
  if (existing) {
    await db.run(
      `UPDATE credentials
          SET secret_hash = {secretHash}, updated_at = {now}
        WHERE id = {id}`,
      { id: existing.id, secretHash, now }
    );
    return existing.id;
  }

  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO credentials
      (id, user_id, type, secret_hash, created_at, updated_at)
     VALUES
      ({id}, {userId}, 'password', {secretHash}, {createdAt}, {updatedAt})`,
    { id, userId, secretHash, createdAt: now, updatedAt: now }
  );
  return id;
}

export async function getPasswordCredential(db, userId) {
  return db.get(
    `SELECT id, secret_hash
       FROM credentials
      WHERE user_id = {userId} AND type = 'password'`,
    { userId }
  );
}

export async function setSystemAdmin(db, userId, value = true) {
  await db.run(
    'UPDATE users SET is_system_admin = {value}, updated_at = {now} WHERE id = {userId}',
    { value: value ? 1 : 0, now: Date.now(), userId }
  );
}

export async function updateLastLogin(db, userId, now = Date.now()) {
  await db.run(
    'UPDATE users SET last_login_at = {now}, updated_at = {now} WHERE id = {userId}',
    { now, userId }
  );
}

export async function assignHomeRealmForEmail(db, userId, email) {
  const domain = emailDomain(email);
  if (!domain) return null;

  const owner = await db.get(
    `SELECT realm_id
       FROM realm_email_domains
      WHERE domain = {domain} AND verified = 1`,
    { domain }
  );
  if (!owner) return null;

  const user = await findUserById(db, userId);
  if (!user) throw new Error(`unknown user: ${userId}`);
  if (!user.home_realm_id) {
    await db.run(
      'UPDATE users SET home_realm_id = {realmId}, updated_at = {now} WHERE id = {userId}',
      { realmId: owner.realm_id, now: Date.now(), userId }
    );
    return owner.realm_id;
  }
  if (user.home_realm_id !== owner.realm_id) {
    throw new HttpError(409, 'home_realm_conflict', 'This email belongs to a different realm');
  }
  return user.home_realm_id;
}

export async function getMembership(db, userId) {
  return db.get(
    'SELECT user_id, status, created_at, updated_at FROM realm_memberships WHERE user_id = {userId}',
    { userId }
  );
}

export async function ensureMembership(db, userId, status = 'active') {
  const existing = await getMembership(db, userId);
  const now = Date.now();
  if (!existing) {
    await db.run(
      `INSERT INTO realm_memberships (user_id, status, created_at, updated_at)
       VALUES ({userId}, {status}, {createdAt}, {updatedAt})`,
      { userId, status, createdAt: now, updatedAt: now }
    );
    return;
  }
  if (existing.status !== status) {
    await db.run(
      'UPDATE realm_memberships SET status = {status}, updated_at = {now} WHERE user_id = {userId}',
      { status, now, userId }
    );
  }
}

export async function getUserRoles(db, userId) {
  const rows = await db.all(
    `SELECT r.slug
       FROM membership_roles mr
       JOIN roles r ON r.id = mr.role_id
      WHERE mr.user_id = {userId}
      ORDER BY r.slug ASC`,
    { userId }
  );
  return rows.map((row) => row.slug);
}

export async function assignRole(db, userId, roleSlug) {
  const role = await db.get('SELECT id FROM roles WHERE slug = {slug}', { slug: roleSlug });
  if (!role) throw new Error(`unknown role: ${roleSlug}`);
  const existing = await db.get(
    'SELECT user_id FROM membership_roles WHERE user_id = {userId} AND role_id = {roleId}',
    { userId, roleId: role.id }
  );
  if (existing) return;
  await db.run(
    'INSERT INTO membership_roles (user_id, role_id) VALUES ({userId}, {roleId})',
    { userId, roleId: role.id }
  );
}
