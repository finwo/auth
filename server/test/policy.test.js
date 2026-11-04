import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canCreateRealm,
  canDeleteRealm,
  canManageUser,
  canUseClient,
  effectiveMembershipStatus,
  effectiveRealmRoles,
  isRealmAdmin,
  isRealmOwner,
  isSystemAdmin,
} from '../src/lib/policy.js';
import { getSystemClient, isSystemClient } from '../src/lib/oidc/clients.js';

const realm = { id: 'realm-a' };
const user = { id: 'u1', status: 'active', home_realm_id: 'realm-a' };
const guest = { id: 'u2', status: 'active', home_realm_id: 'realm-b' };
const activeMembership = { status: 'active' };
const suspendedMembership = { status: 'suspended' };

function client(access_mode, required_roles = []) {
  return { access_mode, enabled: 1, required_roles };
}

test('internal clients accept only home-realm users', () => {
  const c = client('internal');
  assert.equal(canUseClient({ user, membership: activeMembership, roles: [], client: c, realm }), true);
  assert.equal(canUseClient({ user: guest, membership: activeMembership, roles: [], client: c, realm }), false);
});

test('members clients accept home and guest members', () => {
  const c = client('members');
  assert.equal(canUseClient({ user, membership: activeMembership, roles: [], client: c, realm }), true);
  assert.equal(canUseClient({ user: guest, membership: activeMembership, roles: [], client: c, realm }), true);
  assert.equal(canUseClient({ user: guest, membership: suspendedMembership, roles: [], client: c, realm }), false);
});

test('public clients accept non-members and ignore role requirements', () => {
  const c = client('public', ['realm-admin']);
  assert.equal(canUseClient({ user: guest, membership: null, roles: [], client: c, realm }), true);
});

test('required roles are any-of', () => {
  const c = client('members', ['realm-admin', 'auditor']);
  assert.equal(
    canUseClient({ user: guest, membership: activeMembership, roles: ['auditor'], client: c, realm }),
    true
  );
  assert.equal(
    canUseClient({ user: guest, membership: activeMembership, roles: ['member'], client: c, realm }),
    false
  );
});

test('disabled users and clients are denied', () => {
  const disabledUser = { ...user, status: 'disabled' };
  assert.equal(
    canUseClient({ user: disabledUser, membership: activeMembership, roles: [], client: client('public'), realm }),
    false
  );
  assert.equal(
    canUseClient({
      user,
      membership: activeMembership,
      roles: [],
      client: { ...client('members'), enabled: 0 },
      realm,
    }),
    false
  );
});

test('admin and account are built-in system clients', () => {
  assert.equal(isSystemClient('admin'), true);
  assert.equal(isSystemClient('account'), true);
  assert.equal(isSystemClient('internal-app'), false);
  assert.equal(getSystemClient('admin').system_client, true);
  assert.equal(getSystemClient('missing'), null);
  assert.equal(isSystemAdmin({ is_system_admin: 1 }), true);
  assert.equal(isSystemAdmin({ is_system_admin: 0 }), false);
});

test('realm admins manage home users fully and guests by membership only', () => {
  assert.equal(isRealmAdmin(['realm-admin']), true);
  assert.equal(
    canManageUser({ actorRoles: ['realm-admin'], actorIsSystemAdmin: false, target: user, realm }),
    'full'
  );
  assert.equal(
    canManageUser({ actorRoles: ['realm-admin'], actorIsSystemAdmin: false, target: guest, realm }),
    'membership'
  );
  assert.equal(
    canManageUser({ actorRoles: [], actorIsSystemAdmin: false, target: guest, realm }),
    null
  );
});

test('realm creation is limited to system admins', () => {
  assert.equal(canCreateRealm({ id: 'system', status: 'active', is_system_admin: 1 }), true);
  assert.equal(canCreateRealm({ id: 'admin', status: 'active', is_system_admin: 0 }), false);
  assert.equal(canCreateRealm({ id: 'global', status: 'active' }), false);
  assert.equal(
    canCreateRealm({ id: 'system', status: 'disabled', is_system_admin: 1 }),
    false
  );
});

test('realm owners have implicit realm-admin permissions and delete access', () => {
  const ownedRealm = { id: 'realm-a', owner_user_id: 'owner' };
  const owner = { id: 'owner', status: 'active', home_realm_id: 'realm-b' };

  assert.equal(isRealmOwner(owner, ownedRealm), true);
  assert.deepEqual(effectiveRealmRoles(owner, ownedRealm, ['member']), ['member', 'realm-admin']);
  assert.equal(effectiveMembershipStatus(owner, suspendedMembership, ownedRealm), 'active');
  assert.equal(canDeleteRealm({ actor: owner, realm: ownedRealm }), true);
  assert.equal(canDeleteRealm({ actor: guest, realm: ownedRealm }), false);
  assert.equal(
    canManageUser({ actorRoles: ['realm-admin'], actorIsSystemAdmin: false, target: owner, realm: ownedRealm }),
    null
  );
});
