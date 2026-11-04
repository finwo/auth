export const REALM_ADMIN_ROLE = 'realm-admin';

export function isRealmAdmin(roles) {
  return Array.isArray(roles) && roles.includes(REALM_ADMIN_ROLE);
}

export function isSystemAdmin(user) {
  return Boolean(user?.is_system_admin);
}

export function isRealmOwner(user, realm) {
  return Boolean(
    user?.status === 'active' &&
      realm?.owner_user_id &&
      user?.id === realm.owner_user_id
  );
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

export function canManageUser({ actorRoles, actorIsSystemAdmin, target, realm }) {
  if (actorIsSystemAdmin) return 'full';
  if (!isRealmAdmin(actorRoles)) return null;
  if (!target) return null;
  if (isRealmOwner(target, realm)) return null;
  if (target.home_realm_id === realm?.id) return 'full';
  return 'membership';
}

export function canCreateRealm(user, context = {}) {
  if (!user || user.status !== 'active') return false;
  if (isSystemAdmin(user)) return true;
  return Boolean(context?.can_create_realm);
}

export function canDeleteRealm({ actor, realm }) {
  return Boolean(isSystemAdmin(actor) || isRealmOwner(actor, realm));
}

export function effectiveRealmRoles(user, realm, roles) {
  const effectiveRoles = Array.isArray(roles) ? [...roles] : [];
  if (isRealmOwner(user, realm) && !effectiveRoles.includes(REALM_ADMIN_ROLE)) {
    effectiveRoles.push(REALM_ADMIN_ROLE);
  }
  return effectiveRoles.sort();
}

export function effectiveMembershipStatus(user, membership, realm) {
  if (isRealmOwner(user, realm)) return 'active';
  if (membership) return membership.status;
  return user?.home_realm_id === realm?.id ? 'active' : null;
}

export function relationshipFor(user, membership, realm) {
  if (user?.home_realm_id === realm?.id) return 'home';
  if (membership || isRealmOwner(user, realm)) return 'guest';
  return 'none';
}
