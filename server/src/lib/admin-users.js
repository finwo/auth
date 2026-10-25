import { HttpError } from './http/http-error.js';
import { inClause } from './db/query.js';
import { splitScopes } from './consents.js';
import { isSystemAdmin } from './policy.js';
import { openRealmDatabase, realmMetadata } from './realm.js';
import {
  findUserById,
  getMembership,
  getPrimaryEmail,
  getUserRoles,
} from './users.js';

function uniqueUserIds(...groups) {
  return [...new Set(groups.flat().map((group) => group.user_id || group.id))];
}

function groupRows(rows, key, valueKey = null) {
  const grouped = new Map();
  for (const row of rows) {
    const current = grouped.get(row[key]) || [];
    current.push(valueKey ? row[valueKey] : row);
    grouped.set(row[key], current);
  }
  return grouped;
}

function firstRows(rows, key) {
  const first = new Map();
  for (const row of rows) {
    if (!first.has(row[key])) first.set(row[key], row);
  }
  return first;
}

function compareUsers(a, b) {
  const left = `${a.display_name || a.username} ${a.username}`.toLowerCase();
  const right = `${b.display_name || b.username} ${b.username}`.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export async function assertAdminRealmUser({ systemDb, realmDb, realmId, userId }) {
  const user = await findUserById(systemDb, userId);
  if (!user) {
    throw new HttpError(404, 'user_not_found', 'User not found');
  }

  const membership = await getMembership(realmDb, userId);
  if (user.home_realm_id !== realmId && !membership) {
    throw new HttpError(404, 'user_not_found', 'User not found');
  }

  return user;
}

export async function listAdminRealmUsers(systemDb, realmDb, realmId) {
  const membershipRows = await realmDb.all(
    'SELECT user_id, status FROM realm_memberships'
  );
  const homeRows = await systemDb.all(
    'SELECT id FROM users WHERE home_realm_id = {realmId}',
    { realmId }
  );
  const ids = uniqueUserIds(membershipRows, homeRows);
  if (ids.length === 0) return [];

  const userClause = inClause('userId', ids);
  const userRows = await systemDb.all(
    `SELECT id, username, display_name, status, home_realm_id,
            is_system_admin, last_login_at, created_at, updated_at
       FROM users
      WHERE id IN (${userClause.sql})`,
    userClause.params
  );

  const emailClause = inClause('emailUserId', ids);
  const emailRows = await systemDb.all(
    `SELECT user_id, email
       FROM user_emails
      WHERE verified = 1 AND user_id IN (${emailClause.sql})
      ORDER BY user_id ASC, is_primary DESC, created_at ASC`,
    emailClause.params
  );

  const roleRows = await realmDb.all(
    `SELECT mr.user_id, r.slug
       FROM membership_roles mr
       JOIN roles r ON r.id = mr.role_id
      ORDER BY r.slug ASC`
  );
  const banRows = await realmDb.all(
    'SELECT user_id, client_id FROM app_bans ORDER BY client_id ASC'
  );

  const usersById = new Map(userRows.map((row) => [row.id, row]));
  const membershipsByUser = new Map(membershipRows.map((row) => [row.user_id, row]));
  const emailsByUser = firstRows(emailRows, 'user_id');
  const rolesByUser = groupRows(roleRows, 'user_id', 'slug');
  const bansByUser = groupRows(banRows, 'user_id');

  return userRows
    .map((user) => {
      const membership = membershipsByUser.get(user.id) || null;
      const relationship = user.home_realm_id === realmId ? 'home' : 'guest';
      const bans = bansByUser.get(user.id) || [];
      return {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        email: emailsByUser.get(user.id)?.email || null,
        status: user.status,
        membership_status: membership?.status || (relationship === 'home' ? 'active' : null),
        relationship,
        roles: rolesByUser.get(user.id) || [],
        is_system_admin: Boolean(user.is_system_admin),
        banned: bans.length > 0,
        ban_count: bans.length,
        last_login_at: user.last_login_at,
        created_at: user.created_at,
      };
    })
    .sort(compareUsers);
}

export async function getAdminRealmUserDetail(systemDb, realmDb, realmId, userId) {
  const user = await findUserById(systemDb, userId);
  if (!user) return null;

  const membership = await getMembership(realmDb, userId);
  if (user.home_realm_id !== realmId && !membership) return null;

  const roles = await getUserRoles(realmDb, userId);
  const email = await systemDb.get(
    `SELECT email
       FROM user_emails
      WHERE user_id = {userId} AND verified = 1
      ORDER BY is_primary DESC, created_at ASC
      LIMIT 1`,
    { userId }
  );
  const consentRows = await systemDb.all(
    `SELECT user_id, realm_id, client_id, scopes, granted_via, created_at,
            updated_at, revoked_at
       FROM client_consents
      WHERE user_id = {userId} AND realm_id = {realmId}
      ORDER BY client_id ASC`,
    { userId, realmId }
  );
  const clientRows = await realmDb.all(
    'SELECT client_id, name, consent_mode FROM oidc_clients'
  );
  const banRows = await realmDb.all(
    `SELECT user_id, client_id, created_by, created_at
       FROM app_bans
      WHERE user_id = {userId}
      ORDER BY CASE WHEN client_id = '*' THEN 0 ELSE 1 END, client_id ASC`,
    { userId }
  );

  const creatorIds = [...new Set(banRows.map((row) => row.created_by).filter(Boolean))];
  const creatorsById = new Map();
  if (creatorIds.length > 0) {
    const creatorClause = inClause('creatorId', creatorIds);
    const creatorRows = await systemDb.all(
      `SELECT id, username FROM users WHERE id IN (${creatorClause.sql})`,
      creatorClause.params
    );
    for (const creator of creatorRows) {
      creatorsById.set(creator.id, creator.username);
    }
  }

  const clientsById = new Map(
    clientRows.map((row) => [
      row.client_id,
      { name: row.name, consent_mode: row.consent_mode || 'remembered' },
    ])
  );

  return {
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      email: email?.email || null,
      status: user.status,
      membership_status: membership?.status || (user.home_realm_id === realmId ? 'active' : null),
      relationship: user.home_realm_id === realmId ? 'home' : 'guest',
      roles,
      is_system_admin: Boolean(user.is_system_admin),
      banned: banRows.length > 0,
      ban_count: banRows.length,
      home_realm_id: user.home_realm_id,
      last_login_at: user.last_login_at,
      created_at: user.created_at,
      updated_at: user.updated_at,
    },
    consents: consentRows.map((consent) => {
      const client = clientsById.get(consent.client_id) || null;
      return {
        client_id: consent.client_id,
        client_name: client?.name || null,
        client_consent_mode: client?.consent_mode || null,
        scopes: splitScopes(consent.scopes),
        granted_via: consent.granted_via,
        created_at: consent.created_at,
        updated_at: consent.updated_at,
        revoked_at: consent.revoked_at,
        active: !consent.revoked_at,
      };
    }),
    bans: banRows.map((ban) => ({
      client_id: ban.client_id,
      client_name: ban.client_id === '*' ? 'All apps' : clientsById.get(ban.client_id)?.name || null,
      created_by: ban.created_by,
      created_by_username: creatorsById.get(ban.created_by) || null,
      created_at: ban.created_at,
    })),
  };
}

export async function getAdminCurrentUser(systemDb, user) {
  const email = await getPrimaryEmail(systemDb, user.id);
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    email: email?.email || null,
    is_system_admin: isSystemAdmin(user),
  };
}

export async function listAdminGlobalUsers(systemDb, actor) {
  if (!isSystemAdmin(actor)) {
    throw new HttpError(403, 'forbidden', 'System administrator access is required');
  }

  const userRows = await systemDb.all(
    `SELECT id, username, display_name, status, home_realm_id,
            is_system_admin, last_login_at, created_at
       FROM users`
  );
  if (userRows.length === 0) return [];

  const ids = userRows.map((row) => row.id);
  const emailClause = inClause('emailUserId', ids);
  const emailRows = await systemDb.all(
    `SELECT user_id, email
       FROM user_emails
      WHERE verified = 1 AND user_id IN (${emailClause.sql})
      ORDER BY user_id ASC, is_primary DESC, created_at ASC`,
    emailClause.params
  );

  const realmRows = await systemDb.all(
    'SELECT id, slug, db_file FROM realms ORDER BY slug ASC'
  );
  const realmsById = new Map(realmRows.map((row) => [row.id, row]));
  const membershipCounts = new Map();
  for (const realm of realmRows) {
    const realmDb = await openRealmDatabase(realm);
    const members = await realmDb.all('SELECT user_id FROM realm_memberships');
    for (const member of members) {
      membershipCounts.set(member.user_id, (membershipCounts.get(member.user_id) || 0) + 1);
    }
  }

  const emailsByUser = firstRows(emailRows, 'user_id');
  return userRows
    .map((user) => ({
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      email: emailsByUser.get(user.id)?.email || null,
      status: user.status,
      is_system_admin: Boolean(user.is_system_admin),
      home_realm_slug: realmsById.get(user.home_realm_id)?.slug || null,
      membership_count: membershipCounts.get(user.id) || 0,
      last_login_at: user.last_login_at,
      created_at: user.created_at,
    }))
    .sort(compareUsers);
}

export async function getAdminGlobalUserOverview(systemDb, actor, userId) {
  if (!isSystemAdmin(actor)) {
    throw new HttpError(403, 'forbidden', 'System administrator access is required');
  }

  const user = await findUserById(systemDb, userId);
  if (!user) return null;

  const email = await getPrimaryEmail(systemDb, userId);
  const realmRows = await systemDb.all(
    'SELECT id, slug, db_file FROM realms ORDER BY slug ASC'
  );
  const memberships = [];
  for (const realm of realmRows) {
    const realmDb = await openRealmDatabase(realm);
    const membership = await getMembership(realmDb, userId);
    const isHome = user.home_realm_id === realm.id;
    if (!isHome && !membership) continue;

    const roles = await getUserRoles(realmDb, userId);
    const bannedRow = await realmDb.get(
      'SELECT 1 AS banned FROM app_bans WHERE user_id = {userId} LIMIT 1',
      { userId }
    );
    let displayName = realm.slug;
    try {
      const metadata = await realmMetadata(realm);
      displayName = metadata.display_name;
    } catch {
      continue;
    }

    memberships.push({
      slug: realm.slug,
      display_name: displayName,
      relationship: isHome ? 'home' : 'guest',
      membership_status: membership?.status || 'active',
      roles,
      banned: Boolean(bannedRow),
    });
  }

  return {
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      email: email?.email || null,
      status: user.status,
      is_system_admin: Boolean(user.is_system_admin),
      home_realm_slug: memberships.find((realm) => realm.relationship === 'home')?.slug || null,
      last_login_at: user.last_login_at,
      created_at: user.created_at,
      updated_at: user.updated_at,
    },
    memberships,
  };
}
