import { normalizeBrandingPatch } from './admin-branding.js';
import { validateDisplayName } from './admin-settings.js';
import { HttpError } from './http/http-error.js';
import { canDeleteRealm, REALM_ADMIN_ROLE } from './policy.js';
import {
  createRealm,
  findRealmBySlug,
  normalizeRealmSlug,
  openRealmDatabase,
  removeRealmDatabase,
} from './realm.js';
import { destroySessionById } from './session.js';
import { listAdminRealms } from './system-clients.js';
import { assignRole, ensureMembership } from './users.js';

const CREATE_ALLOWED_FIELDS = new Set(['slug', 'display_name', 'logo_url', 'primary_color']);

function invalidRequest(message) {
  return new HttpError(400, 'invalid_request', message);
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
    if (!allowed.has(field)) {
      throw invalidRequest(`Unknown field: ${field}`);
    }
  }
}

function serializeBrandedObject(brandingPatch) {
  const branding = {};
  if (brandingPatch.logo_url) branding.logo_url = brandingPatch.logo_url;
  if (brandingPatch.primary_color) branding.primary_color = brandingPatch.primary_color;
  return branding;
}

export function normalizeCreateRealmInput(body) {
  assertBody(body);
  assertKnownFields(body, CREATE_ALLOWED_FIELDS);

  if (!Object.hasOwn(body, 'slug')) throw invalidRequest('slug is required');
  if (!Object.hasOwn(body, 'display_name')) throw invalidRequest('display_name is required');
  if (typeof body.slug !== 'string') throw invalidRequest('slug must be a string');

  let slug;
  try {
    slug = normalizeRealmSlug(body.slug);
  } catch (e) {
    throw invalidRequest(e.message);
  }

  const displayName = validateDisplayName(body.display_name);
  const branding = serializeBrandedObject(normalizeBrandingPatch(body));

  return { slug, displayName, branding };
}

function serializeOwner(ownerUserId, owner) {
  if (!ownerUserId) return null;
  return {
    id: ownerUserId,
    username: owner?.username || null,
    display_name: owner?.display_name || null,
  };
}

async function countRealmRows(systemDb, table, realmId) {
  const row = await systemDb.get(
    `SELECT COUNT(*) AS count FROM ${table} WHERE realm_id = {realmId}`,
    { realmId }
  );
  return Number(row?.count || 0);
}

export async function loadAdminRealmDetail(systemDb, realm, actor) {
  const realmDb = await openRealmDatabase(realm);
  const settings = await realmDb.get(
    'SELECT display_name, status, updated_at FROM realm_settings WHERE id = 1'
  );
  if (!settings || settings.status !== 'active') {
    throw new HttpError(404, 'unknown_realm', 'Unknown realm');
  }

  const owner = realm.owner_user_id
    ? await systemDb.get('SELECT id, username, display_name FROM users WHERE id = {id}', {
        id: realm.owner_user_id,
      })
    : null;
  const homeUsers = await systemDb.all('SELECT id FROM users WHERE home_realm_id = {realmId}', {
    realmId: realm.id,
  });
  const memberships = await realmDb.all('SELECT user_id FROM realm_memberships');

  const memberIds = new Set(homeUsers.map((row) => row.id));
  for (const membership of memberships) memberIds.add(membership.user_id);
  if (realm.owner_user_id) memberIds.add(realm.owner_user_id);

  return {
    slug: realm.slug,
    display_name: settings.display_name,
    owner: serializeOwner(realm.owner_user_id, owner),
    host_count: await countRealmRows(systemDb, 'realm_hosts', realm.id),
    email_domain_count: await countRealmRows(systemDb, 'realm_email_domains', realm.id),
    client_count: await countRealmRows(systemDb, 'client_realms', realm.id),
    member_count: memberIds.size,
    created_at: realm.created_at,
    updated_at: settings.updated_at,
    can_edit: true,
    can_delete: canDeleteRealm({ actor, realm }),
  };
}

export async function listAdminRealmsDetail(systemDb, actor) {
  const realms = await listAdminRealms(systemDb, actor);
  const details = [];

  for (const realm of realms) {
    try {
      details.push(await loadAdminRealmDetail(systemDb, realm, actor));
    } catch {
      continue;
    }
  }

  return details;
}

export async function createAdminRealm({ systemDb, actor, body }) {
  const input = normalizeCreateRealmInput(body);

  let created;
  try {
    created = await createRealm({
      slug: input.slug,
      displayName: input.displayName,
      branding: input.branding,
      ownerUserId: actor.id,
    });
  } catch (e) {
    if (
      /realm already exists|UNIQUE constraint failed: realms.slug/.test(e.message)
    ) {
      throw conflict('Realm slug already exists', 'realm_slug_exists');
    }
    if (/realm slug/.test(e.message)) {
      throw invalidRequest(e.message);
    }
    throw e;
  }

  try {
    const realmDb = await openRealmDatabase(created);
    await realmDb.transaction(async (tx) => {
      await ensureMembership(tx, actor.id, 'active');
      await assignRole(tx, actor.id, REALM_ADMIN_ROLE);
    });
  } catch (e) {
    try {
      await systemDb.run('DELETE FROM realms WHERE id = {id}', { id: created.id });
      await removeRealmDatabase(created);
    } catch {
      // The original creation error is more actionable than rollback cleanup.
    }
    throw e;
  }

  const realm = await findRealmBySlug(created.slug);
  return loadAdminRealmDetail(systemDb, realm || created, actor);
}

export async function deleteAdminRealm({ systemDb, actor, realm }) {
  if (!canDeleteRealm({ actor, realm })) {
    throw forbidden('Realm owner or system administrator access is required');
  }

  const now = Date.now();
  await systemDb.transaction(async (tx) => {
    await tx.run(
      'UPDATE users SET home_realm_id = NULL, updated_at = {now} WHERE home_realm_id = {realmId}',
      { now, realmId: realm.id }
    );

    const sessions = await tx.all('SELECT id FROM sessions WHERE realm_id = {realmId}', {
      realmId: realm.id,
    });
    for (const session of sessions) {
      await destroySessionById(tx, session.id, now);
    }
    await tx.run(
      `DELETE FROM session_groups
        WHERE id NOT IN (SELECT group_id FROM sessions WHERE group_id IS NOT NULL)`
    );

    await tx.run('DELETE FROM session_realms WHERE realm_id = {realmId}', { realmId: realm.id });
    await tx.run('DELETE FROM refresh_tokens WHERE realm_id = {realmId}', { realmId: realm.id });
    await tx.run('DELETE FROM client_consents WHERE realm_id = {realmId}', { realmId: realm.id });
    await tx.run('DELETE FROM client_realms WHERE realm_id = {realmId}', { realmId: realm.id });
    await tx.run('DELETE FROM realm_hosts WHERE realm_id = {realmId}', { realmId: realm.id });
    await tx.run('DELETE FROM realm_email_domains WHERE realm_id = {realmId}', {
      realmId: realm.id,
    });
    await tx.run('DELETE FROM realms WHERE id = {id}', { id: realm.id });
  });

  await removeRealmDatabase(realm);
  return { removed: true };
}
