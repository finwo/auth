export function isRealmAdmin(roles) {
  return Array.isArray(roles) && roles.includes('realm-admin');
}

export function isSystemAdmin(roles) {
  return Array.isArray(roles) && roles.includes('system-admin');
}

export function canUseClient({ user, membership, roles, client, realm }) {
  if (!user || user.status !== 'active') return false;
  if (!client || !client.enabled) return false;

  const requiredRoles = Array.isArray(client.required_roles) ? client.required_roles : [];
  const roleOk = requiredRoles.length === 0 || requiredRoles.some((role) => roles.includes(role));

  if (client.access_mode === 'public') return true;

  if (!membership || membership.status !== 'active') return false;

  if (client.access_mode === 'internal') {
    return user.home_realm_id === realm.id && roleOk;
  }

  if (client.access_mode === 'members') {
    return roleOk;
  }

  return false;
}

export function canManageUser({ actorRoles, actorIsSystemAdmin, target, realmId }) {
  if (actorIsSystemAdmin) return 'full';
  if (!isRealmAdmin(actorRoles)) return null;
  if (!target) return null;
  if (target.home_realm_id === realmId) return 'full';
  return 'membership';
}
