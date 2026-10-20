import test from 'node:test';
import assert from 'node:assert/strict';
import { canManageUser, canUseClient, isRealmAdmin, isSystemAdmin } from '../src/lib/policy.js';

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

test('virtual admin clients accept system admins and realm admins', () => {
  const adminClient = { ...client('admin'), virtual: true, client_id: 'admin' };
  const systemAdmin = { ...guest, is_system_admin: 1 };

  assert.equal(
    canUseClient({ user: systemAdmin, membership: null, roles: [], client: adminClient, realm }),
    true
  );
  assert.equal(
    canUseClient({
      user: guest,
      membership: activeMembership,
      roles: ['realm-admin'],
      client: adminClient,
      realm,
    }),
    true
  );
  assert.equal(
    canUseClient({
      user: guest,
      membership: activeMembership,
      roles: [],
      client: adminClient,
      realm,
    }),
    false
  );
});

test('virtual account clients accept every active user', () => {
  const accountClient = { ...client('public'), virtual: true, client_id: 'account' };
  assert.equal(
    canUseClient({ user: guest, membership: null, roles: [], client: accountClient, realm }),
    true
  );
  assert.equal(isSystemAdmin({ is_system_admin: 1 }), true);
  assert.equal(isSystemAdmin({ is_system_admin: 0 }), false);
});

test('realm admins manage home users fully and guests by membership only', () => {
  assert.equal(isRealmAdmin(['realm-admin']), true);
  assert.equal(
    canManageUser({ actorRoles: ['realm-admin'], actorIsSystemAdmin: false, target: user, realmId: 'realm-a' }),
    'full'
  );
  assert.equal(
    canManageUser({ actorRoles: ['realm-admin'], actorIsSystemAdmin: false, target: guest, realmId: 'realm-a' }),
    'membership'
  );
  assert.equal(
    canManageUser({ actorRoles: [], actorIsSystemAdmin: false, target: guest, realmId: 'realm-a' }),
    null
  );
});
