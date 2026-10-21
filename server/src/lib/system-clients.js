import { isSystemAdmin } from './policy.js';
import { openRealmDatabase } from './realm.js';
import { getMembership, getUserRoles } from './users.js';

export async function listAdminRealms(systemDb, user) {
  const realms = await systemDb.all(
    'SELECT id, slug, db_file, owner_user_id FROM realms ORDER BY slug ASC'
  );
  if (isSystemAdmin(user)) return realms;

  const accessible = [];
  for (const realm of realms) {
    try {
      const db = await openRealmDatabase(realm);
      const membership = await getMembership(db, user.id);
      if (membership?.status !== 'active') continue;
      const roles = await getUserRoles(db, user.id);
      if (roles.includes('realm-admin')) accessible.push(realm);
    } catch {
      continue;
    }
  }
  return accessible;
}

export async function canUseSystemClient(systemDb, { user, client }) {
  if (!user || user.status !== 'active' || !client?.enabled) return false;
  if (client.client_id === 'account') return true;
  if (client.client_id !== 'admin') return false;
  if (isSystemAdmin(user)) return true;
  return (await listAdminRealms(systemDb, user)).length > 0;
}
