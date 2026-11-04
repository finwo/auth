import { HttpError } from './http/http-error.js';
import { inClause } from './db/query.js';
import { revokeUserRealmAccess } from './bans.js';
import { splitScopes } from './consents.js';
import {
  canCreateRealm,
  canManageUser,
  effectiveMembershipStatus,
  effectiveRealmRoles,
  isRealmAdmin,
  isRealmOwner,
  isSystemAdmin,
  REALM_ADMIN_ROLE,
  relationshipFor,
} from './policy.js';
import { openRealmDatabase, realmMetadata } from './realm.js';
import { revokeUserRealmSessions } from './session.js';
import {
  findUserById,
  findUserByIdentifier,
  getMembership,
  getPrimaryEmail,
  getUserRoles,
  replaceUserRoles,
  setMembershipStatus,
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

const MEMBERSHIP_STATUSES = new Set(['active', 'suspended']);
const MAX_ROLE_COUNT = 50;

function invalidRequest(message, code = 'invalid_request') {
  return new HttpError(400, code, message);
}

function notFound(message, code = 'user_not_found') {
  return new HttpError(404, code, message);
}

function forbidden(message) {
  return new HttpError(403, 'forbidden', message);
}

function conflict(message, code) {
  return new HttpError(409, code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertBody(body) {
  if (!isPlainObject(body)) {
    throw invalidRequest('Request body must be a JSON object');
  }
}

function assertKnownFields(body, allowed) {
  for (const field of Object.keys(body)) {
    if (!allowed.has(field)) throw invalidRequest(`Unknown field: ${field}`);
  }
}

function sameRoleSet(left, right) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function normalizeRoleInput(value) {
  if (!Array.isArray(value)) {
    throw invalidRequest('roles must be an array');
  }
  if (value.length > MAX_ROLE_COUNT) {
    throw invalidRequest(`roles may contain at most ${MAX_ROLE_COUNT} entries`);
  }

  const roles = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw invalidRequest('roles must contain only non-empty strings');
    }
    roles.add(item.trim());
  }
  return [...roles].sort();
}

async function activeRealmAdminCount(systemDb, realmDb, realm) {
  const role = await realmDb.get('SELECT id FROM roles WHERE slug = {roleSlug}', {
    roleSlug: REALM_ADMIN_ROLE,
  });
  if (!role) return 0;

  const assignments = await realmDb.all(
    'SELECT user_id FROM membership_roles WHERE role_id = {roleId}',
    { roleId: role.id }
  );
  const candidateIds = new Set(assignments.map((row) => row.user_id));
  if (realm?.owner_user_id) candidateIds.add(realm.owner_user_id);
  if (candidateIds.size === 0) return 0;

  const ids = [...candidateIds];
  const clause = inClause('roleIdUserId', ids);
  const users = await systemDb.all(
    `SELECT id, status, home_realm_id
       FROM users
      WHERE id IN (${clause.sql})`,
    clause.params
  );
  const memberships = await realmDb.all('SELECT user_id, status FROM realm_memberships');
  const membershipsByUser = new Map(memberships.map((row) => [row.user_id, row]));

  return users.filter((user) => {
    if (user.status !== 'active') return false;
    const membership = membershipsByUser.get(user.id) || null;
    return effectiveMembershipStatus(user, membership, realm) === 'active';
  }).length;
}

async function getAdminRealmUserPermissions({
  systemDb,
  realmDb,
  realm,
  target,
  membership,
  roles,
  actor,
  actorRoles,
}) {
  const manageLevel = canManageUser({
    actorRoles,
    actorIsSystemAdmin: isSystemAdmin(actor),
    target,
    realm,
  });
  const effectiveStatus = effectiveMembershipStatus(target, membership, realm);
  const targetActive = target.status === 'active';
  const lastActiveRealmAdmin =
    isRealmAdmin(roles) &&
    targetActive &&
    effectiveStatus === 'active' &&
    (await activeRealmAdminCount(systemDb, realmDb, realm)) <= 1;
  const lastAdminOverride = isSystemAdmin(actor);
  const ownerProtected = isRealmOwner(target, realm);
  const canReactivateMembership =
    Boolean(manageLevel) && targetActive && effectiveStatus === 'suspended';
  const canSuspendMembership =
    !ownerProtected &&
    Boolean(manageLevel) &&
    targetActive &&
    effectiveStatus === 'active' &&
    (lastAdminOverride || !lastActiveRealmAdmin);

  let reason = null;
  if (!manageLevel) {
    reason = 'not_authorized';
  } else if (!targetActive) {
    reason = 'target_disabled';
  } else if (effectiveStatus === 'invited') {
    reason = 'membership_invited';
  } else if (effectiveStatus === 'suspended') {
    reason = 'membership_suspended';
  } else if (effectiveStatus !== 'active') {
    reason = 'membership_not_found';
  } else if (ownerProtected && !lastAdminOverride) {
    reason = 'not_authorized';
  } else if (ownerProtected) {
    reason = 'realm_owner_active';
  } else if (lastActiveRealmAdmin && !lastAdminOverride) {
    reason = 'last_realm_admin';
  }

  return {
    is_self: actor.id === target.id,
    can_manage_membership: canSuspendMembership || canReactivateMembership,
    can_suspend_membership: canSuspendMembership,
    can_reactivate_membership: canReactivateMembership,
    can_edit_roles: Boolean(manageLevel) && targetActive && effectiveStatus === 'active',
    can_remove_last_realm_admin:
      Boolean(manageLevel) && targetActive && effectiveStatus === 'active' && lastAdminOverride,
    last_active_realm_admin: lastActiveRealmAdmin,
    reason,
  };
}

function serializeAdminRealmUser(user, email, membership, realm, roles, banRows) {
  const relationship = relationshipFor(user, membership, realm);
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    email: email?.email || null,
    status: user.status,
    membership_status: effectiveMembershipStatus(user, membership, realm),
    relationship,
    roles,
    is_system_admin: Boolean(user.is_system_admin),
    banned: banRows.length > 0,
    ban_count: banRows.length,
    home_realm_id: user.home_realm_id,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

async function loadAdminRealmBans(systemDb, realmDb, userId) {
  const banRows = await realmDb.all(
    `SELECT user_id, client_id, created_by, created_at
       FROM app_bans
      WHERE user_id = {userId}
      ORDER BY CASE WHEN client_id = '*' THEN 0 ELSE 1 END, client_id ASC`,
    { userId }
  );
  const clientRows = await realmDb.all('SELECT client_id, name FROM oidc_clients');
  const creatorIds = [...new Set(banRows.map((row) => row.created_by).filter(Boolean))];
  const creatorsById = new Map();
  if (creatorIds.length > 0) {
    const creatorClause = inClause('creatorId', creatorIds);
    const creatorRows = await systemDb.all(
      `SELECT id, username FROM users WHERE id IN (${creatorClause.sql})`,
      creatorClause.params
    );
    for (const creator of creatorRows) creatorsById.set(creator.id, creator.username);
  }

  const clientsById = new Map(clientRows.map((row) => [row.client_id, row.name]));
  return banRows.map((ban) => ({
    client_id: ban.client_id,
    client_name: ban.client_id === '*' ? 'All apps' : clientsById.get(ban.client_id) || null,
    created_by: ban.created_by,
    created_by_username: creatorsById.get(ban.created_by) || null,
    created_at: ban.created_at,
  }));
}

async function loadAdminRealmConsents(systemDb, realmDb, realmId, userId) {
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
  const clientsById = new Map(
    clientRows.map((row) => [
      row.client_id,
      { name: row.name, consent_mode: row.consent_mode || 'remembered' },
    ])
  );

  return consentRows.map((consent) => {
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
  });
}

async function getAdminRealmUserAccessDetail({
  systemDb,
  realmDb,
  realm,
  user,
  actor,
  actorRoles,
}) {
  const membership = await getMembership(realmDb, user.id);
  const roles = effectiveRealmRoles(user, realm, await getUserRoles(realmDb, user.id));
  const email = await systemDb.get(
    `SELECT email
       FROM user_emails
      WHERE user_id = {userId} AND verified = 1
      ORDER BY is_primary DESC, created_at ASC
      LIMIT 1`,
    { userId: user.id }
  );
  const bans = await loadAdminRealmBans(systemDb, realmDb, user.id);
  const consents = await loadAdminRealmConsents(systemDb, realmDb, realm.id, user.id);
  const permissions = await getAdminRealmUserPermissions({
    systemDb,
    realmDb,
    realm,
    target: user,
    membership,
    roles,
    actor,
    actorRoles,
  });

  return {
    user: serializeAdminRealmUser(user, email, membership, realm, roles, bans),
    consents,
    bans,
    permissions,
  };
}

export async function assertAdminRealmUser({ systemDb, realmDb, realm, userId }) {
  const user = await findUserById(systemDb, userId);
  if (!user) {
    throw new HttpError(404, 'user_not_found', 'User not found');
  }

  const membership = await getMembership(realmDb, userId);
  if (user.home_realm_id !== realm.id && !membership && !isRealmOwner(user, realm)) {
    throw new HttpError(404, 'user_not_found', 'User not found');
  }

  return user;
}

export async function listAdminRealmUsers(systemDb, realmDb, realm) {
  const membershipRows = await realmDb.all(
    'SELECT user_id, status FROM realm_memberships'
  );
  const homeRows = await systemDb.all(
    'SELECT id FROM users WHERE home_realm_id = {realmId}',
    { realmId: realm.id }
  );
  const ownerRows = realm.owner_user_id ? [{ id: realm.owner_user_id }] : [];
  const ids = uniqueUserIds(membershipRows, homeRows, ownerRows);
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

  const membershipsByUser = new Map(membershipRows.map((row) => [row.user_id, row]));
  const emailsByUser = firstRows(emailRows, 'user_id');
  const rolesByUser = groupRows(roleRows, 'user_id', 'slug');
  const bansByUser = groupRows(banRows, 'user_id');

  return userRows
    .map((user) => {
      const membership = membershipsByUser.get(user.id) || null;
      const relationship = relationshipFor(user, membership, realm);
      const bans = bansByUser.get(user.id) || [];
      return {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        email: emailsByUser.get(user.id)?.email || null,
        status: user.status,
        membership_status: effectiveMembershipStatus(user, membership, realm),
        relationship,
        roles: effectiveRealmRoles(user, realm, rolesByUser.get(user.id) || []),
        is_system_admin: Boolean(user.is_system_admin),
        banned: bans.length > 0,
        ban_count: bans.length,
        last_login_at: user.last_login_at,
        created_at: user.created_at,
      };
    })
    .sort(compareUsers);
}

export async function getAdminRealmUserDetail({
  systemDb,
  realmDb,
  realm,
  userId,
  actor,
  actorRoles,
}) {
  const user = await findUserById(systemDb, userId);
  if (!user) return null;

  const membership = await getMembership(realmDb, userId);
  if (user.home_realm_id !== realm.id && !membership && !isRealmOwner(user, realm)) {
    return null;
  }

  return getAdminRealmUserAccessDetail({
    systemDb,
    realmDb,
    realm,
    user,
    actor,
    actorRoles,
  });
}

export async function getAdminCurrentUser(systemDb, user) {
  const email = await getPrimaryEmail(systemDb, user.id);
  const homeRealm = user.home_realm_id
    ? await systemDb.get('SELECT slug FROM realms WHERE id = {id}', { id: user.home_realm_id })
    : null;

  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    email: email?.email || null,
    is_system_admin: isSystemAdmin(user),
    home_realm_slug: homeRealm?.slug || null,
    can_create_realm: canCreateRealm(user),
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
    'SELECT id, slug, db_file, owner_user_id FROM realms ORDER BY slug ASC'
  );
  const memberships = [];
  for (const realm of realmRows) {
    const realmDb = await openRealmDatabase(realm);
    const membership = await getMembership(realmDb, userId);
    const relationship = relationshipFor(user, membership, realm);
    if (relationship === 'none') continue;

    const roles = effectiveRealmRoles(user, realm, await getUserRoles(realmDb, userId));
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
      relationship,
      membership_status: effectiveMembershipStatus(user, membership, realm),
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

export async function lookupAdminRealmUser({
  systemDb,
  realmDb,
  realm,
  identifier,
}) {
  if (typeof identifier !== 'string' || !identifier.trim()) {
    throw invalidRequest('identifier is required');
  }

  const user = await findUserByIdentifier(systemDb, identifier);
  if (!user) throw notFound();

  const membership = await getMembership(realmDb, user.id);
  const roles = effectiveRealmRoles(user, realm, await getUserRoles(realmDb, user.id));
  const email = await getPrimaryEmail(systemDb, user.id);
  const homeRealm = user.home_realm_id
    ? await systemDb.get('SELECT slug FROM realms WHERE id = {id}', { id: user.home_realm_id })
    : null;
  const relationship = relationshipFor(user, membership, realm);
  const effectiveStatus = effectiveMembershipStatus(user, membership, realm);

  let canAdd = true;
  let reason = null;
  if (user.status !== 'active') {
    canAdd = false;
    reason = 'user_disabled';
  } else if (relationship !== 'none') {
    canAdd = false;
    reason = 'already_member';
  }

  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    email: email?.email || null,
    status: user.status,
    is_system_admin: Boolean(user.is_system_admin),
    home_realm_slug: homeRealm?.slug || null,
    relationship,
    membership_status: effectiveStatus,
    roles,
    can_add: canAdd,
    reason,
  };
}

export async function addAdminRealmMember({
  systemDb,
  realmDb,
  realm,
  userId,
  actor,
  actorRoles,
}) {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw invalidRequest('user_id is required');
  }

  const user = await findUserById(systemDb, userId.trim());
  if (!user) throw notFound();
  if (user.status !== 'active') throw conflict('This account is disabled', 'user_not_active');
  if (user.home_realm_id === realm.id || isRealmOwner(user, realm)) {
    throw conflict('User is already a member', 'already_member');
  }

  const existing = await getMembership(realmDb, user.id);
  if (existing) throw conflict('User is already a member', 'already_member');

  if (!canManageUser({
    actorRoles,
    actorIsSystemAdmin: isSystemAdmin(actor),
    target: user,
    realm,
  })) {
    throw forbidden('User management access is required');
  }

  const now = Date.now();
  await realmDb.transaction(async (tx) => {
    const current = await tx.get(
      'SELECT user_id FROM realm_memberships WHERE user_id = {userId}',
      { userId: user.id }
    );
    if (current) throw conflict('User is already a member', 'already_member');
    const currentHomeRealm = await systemDb.get('SELECT id FROM realms WHERE id = {id}', {
      id: user.home_realm_id,
    });
    if (currentHomeRealm?.id === realm.id) {
      throw conflict('User is already a member', 'already_member');
    }

    await tx.run(
      `INSERT INTO realm_memberships (user_id, status, created_at, updated_at)
       VALUES ({userId}, 'active', {createdAt}, {updatedAt})`,
      { userId: user.id, createdAt: now, updatedAt: now }
    );
  });

  return getAdminRealmUserAccessDetail({
    systemDb,
    realmDb,
    realm,
    user,
    actor,
    actorRoles,
  });
}

export async function updateAdminRealmMembership({
  systemDb,
  realmDb,
  realm,
  userId,
  body,
  actor,
  actorRoles,
}) {
  assertBody(body);
  assertKnownFields(body, new Set(['status']));
  if (typeof body.status !== 'string' || !MEMBERSHIP_STATUSES.has(body.status)) {
    throw invalidRequest('status must be active or suspended', 'invalid_membership_status');
  }

  const user = await assertAdminRealmUser({ systemDb, realmDb, realm, userId });
  const membership = await getMembership(realmDb, user.id);
  const roles = effectiveRealmRoles(user, realm, await getUserRoles(realmDb, user.id));
  const effectiveStatus = effectiveMembershipStatus(user, membership, realm);
  const manageLevel = canManageUser({
    actorRoles,
    actorIsSystemAdmin: isSystemAdmin(actor),
    target: user,
    realm,
  });
  if (!manageLevel) throw forbidden('User management access is required');
  if (user.status !== 'active') throw conflict('This account is disabled', 'target_disabled');
  if (effectiveStatus === 'invited') {
    throw conflict('Invited membership cannot be changed yet', 'membership_invited');
  }

  const nextStatus = body.status;
  if (nextStatus === 'suspended' && isRealmOwner(user, realm)) {
    throw conflict('Realm owners cannot be suspended', 'realm_owner_active');
  }
  if (nextStatus === effectiveStatus) {
    const detail = await getAdminRealmUserAccessDetail({
      systemDb,
      realmDb,
      realm,
      user,
      actor,
      actorRoles,
    });
    return {
      ...detail,
      revoked: { consents: 0, refresh_tokens: 0, session_realms: 0 },
    };
  }

  if (nextStatus === 'suspended') {
    const lastAdmin =
      isRealmAdmin(roles) &&
      (await activeRealmAdminCount(systemDb, realmDb, realm)) <= 1;
    if (lastAdmin && !isSystemAdmin(actor)) {
      throw conflict('Another active realm admin is required', 'last_realm_admin');
    }
  }

  await setMembershipStatus(realmDb, user.id, nextStatus);
  let revoked = { consents: 0, refresh_tokens: 0, session_realms: 0 };
  if (nextStatus === 'suspended') {
    const now = Date.now();
    const access = await revokeUserRealmAccess(systemDb, {
      userId: user.id,
      realmId: realm.id,
      now,
    });
    const sessionRealms = await revokeUserRealmSessions(systemDb, {
      userId: user.id,
      realmId: realm.id,
      revokedBy: actor.id,
      now,
    });
    revoked = { ...access, session_realms: sessionRealms };
  }

  const detail = await getAdminRealmUserAccessDetail({
    systemDb,
    realmDb,
    realm,
    user,
    actor,
    actorRoles,
  });
  return { ...detail, revoked };
}

export async function updateAdminRealmRoles({
  systemDb,
  realmDb,
  realm,
  userId,
  body,
  actor,
  actorRoles,
}) {
  assertBody(body);
  assertKnownFields(body, new Set(['roles']));
  const requestedRoles = normalizeRoleInput(body.roles);

  const user = await assertAdminRealmUser({ systemDb, realmDb, realm, userId });
  const membership = await getMembership(realmDb, user.id);
  const currentRoles = effectiveRealmRoles(user, realm, await getUserRoles(realmDb, user.id));
  const effectiveStatus = effectiveMembershipStatus(user, membership, realm);
  const manageLevel = canManageUser({
    actorRoles,
    actorIsSystemAdmin: isSystemAdmin(actor),
    target: user,
    realm,
  });
  if (!manageLevel) throw forbidden('User management access is required');
  if (user.status !== 'active') throw conflict('This account is disabled', 'target_disabled');
  if (effectiveStatus !== 'active') {
    throw conflict('An active membership is required', 'membership_not_active');
  }

  let roleIds = [];
  if (requestedRoles.length > 0) {
    const clause = inClause('roleSlug', requestedRoles);
    const roles = await realmDb.all(
      `SELECT id, slug FROM roles WHERE slug IN (${clause.sql})`,
      clause.params
    );
    if (roles.length !== requestedRoles.length) {
      throw invalidRequest('One or more roles do not exist', 'invalid_roles');
    }
    roleIds = roles.map((role) => role.id);
  }

  const remainsRealmAdmin = isRealmOwner(user, realm) || isRealmAdmin(requestedRoles);
  if (
    isRealmAdmin(currentRoles) &&
    !remainsRealmAdmin &&
    (await activeRealmAdminCount(systemDb, realmDb, realm)) <= 1 &&
    !isSystemAdmin(actor)
  ) {
    throw conflict('Another active realm admin is required', 'last_realm_admin');
  }

  await replaceUserRoles(realmDb, user.id, roleIds);
  return getAdminRealmUserAccessDetail({
    systemDb,
    realmDb,
    realm,
    user,
    actor,
    actorRoles,
  });
}
