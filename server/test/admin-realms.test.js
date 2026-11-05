import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  closeRealms,
  findRealmBySlug,
  getSystemDatabase,
  initRealms,
  openRealmDatabase,
} from '../src/lib/realm.js';
import {
  createAdminRealm,
  deleteAdminRealm,
  listAdminRealmsDetail,
  normalizeCreateRealmInput,
} from '../src/lib/admin-realms.js';
import { addUserEmail, createUser, getUserRoles } from '../src/lib/users.js';

async function withRealmRegistry(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-admin-realms-'));
  const realmsPath = path.join(dir, 'realms');
  try {
    const cfg = {
      database: {
        dialect: 'sqlite',
        path: path.join(dir, 'system.sqlite'),
        realms: realmsPath,
      },
    };
    await initRealms(cfg);
    await fn(getSystemDatabase(), realmsPath);
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('normalizeCreateRealmInput validates and normalizes realm creation payloads', () => {
  const input = normalizeCreateRealmInput({
    slug: ' acme-2 ',
    display_name: '  Acme 2  ',
    logo_url: 'https://acme.test/logo.svg',
    primary_color: '#25A',
  });

  assert.deepEqual(input, {
    slug: 'acme-2',
    displayName: 'Acme 2',
    branding: {
      logo_url: 'https://acme.test/logo.svg',
      primary_color: '#2255aa',
    },
  });
});

test('normalizeCreateRealmInput rejects invalid realm creation payloads', () => {
  const invalidBodies = [
    {},
    { slug: 'acme' },
    { display_name: 'Acme' },
    { slug: 'Admin', display_name: 'Acme' },
    { slug: 'global', display_name: 'Global' },
    { slug: 'acme', display_name: '' },
    { slug: 'acme', display_name: 'Acme', unknown: true },
    { slug: 'acme', display_name: 'Acme', primary_color: 'red' },
  ];

  for (const body of invalidBodies) {
    assert.throws(
      () => normalizeCreateRealmInput(body),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'invalid_request');
        return true;
      }
    );
  }
});

test('createAdminRealm assigns creator ownership, membership and realm-admin role', async () => {
  await withRealmRegistry(async (systemDb) => {
    const actorId = await createUser(systemDb, {
      username: 'creator',
      displayName: 'Creator',
      isSystemAdmin: true,
    });
    await addUserEmail(systemDb, actorId, 'creator@example.test', {
      verified: true,
      primary: true,
    });
    const actor = { id: actorId, status: 'active', is_system_admin: 1 };

    const realm = await createAdminRealm({
      systemDb,
      actor,
      body: {
        slug: 'acme',
        display_name: 'Acme',
        primary_color: '#25A',
      },
    });

    assert.equal(realm.slug, 'acme');
    assert.equal(realm.display_name, 'Acme');
    assert.equal(realm.member_count, 1);
    assert.equal(realm.client_count, 0);
    assert.equal(realm.can_edit, true);
    assert.equal(realm.can_delete, true);
    assert.deepEqual(realm.owner, {
      id: actorId,
      username: 'creator',
      display_name: 'Creator',
      email: 'creator@example.test',
    });

    const row = await findRealmBySlug('acme');
    assert.equal(row.owner_user_id, actorId);

    const realmDb = await openRealmDatabase(row);
    assert.deepEqual(
      await realmDb.get('SELECT status FROM realm_memberships WHERE user_id = {userId}', {
        userId: actorId,
      }),
      { status: 'active' }
    );
    assert.deepEqual(await getUserRoles(realmDb, actorId), ['realm-admin']);
    assert.deepEqual(
      JSON.parse((await realmDb.get('SELECT branding FROM realm_settings WHERE id = 1')).branding),
      { primary_color: '#2255aa' }
    );
  });
});

test('createAdminRealm rejects duplicate slugs', async () => {
  await withRealmRegistry(async (systemDb) => {
    const actorId = await createUser(systemDb, {
      username: 'creator',
      isSystemAdmin: true,
    });
    const actor = { id: actorId, status: 'active', is_system_admin: 1 };
    const body = { slug: 'acme', display_name: 'Acme' };

    await createAdminRealm({ systemDb, actor, body });
    await assert.rejects(
      () => createAdminRealm({ systemDb, actor, body }),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'realm_slug_exists');
        return true;
      }
    );
  });
});

test('listAdminRealmsDetail includes owned realms and owner deletion permission', async () => {
  await withRealmRegistry(async (systemDb) => {
    const adminId = await createUser(systemDb, {
      username: 'creator',
      isSystemAdmin: true,
    });
    const ownerId = await createUser(systemDb, { username: 'owner' });
    await addUserEmail(systemDb, ownerId, 'owner@example.test', {
      verified: true,
      primary: true,
    });
    await createAdminRealm({
      systemDb,
      actor: { id: adminId, status: 'active', is_system_admin: 1 },
      body: { slug: 'acme', display_name: 'Acme' },
    });
    const row = await findRealmBySlug('acme');
    await systemDb.run('UPDATE realms SET owner_user_id = {ownerId} WHERE id = {id}', {
      ownerId,
      id: row.id,
    });

    const listed = await listAdminRealmsDetail(systemDb, { id: ownerId, status: 'active' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].slug, 'acme');
    assert.equal(listed[0].can_edit, true);
    assert.equal(listed[0].can_delete, true);
    assert.deepEqual(listed[0].owner, {
      id: ownerId,
      username: 'owner',
      display_name: 'owner',
      email: 'owner@example.test',
    });
    assert.equal(listed[0].member_count, 2);
  });
});

test('deleteAdminRealm removes registry state and realm database files', async () => {
  await withRealmRegistry(async (systemDb, realmsPath) => {
    const adminId = await createUser(systemDb, {
      username: 'creator',
      isSystemAdmin: true,
    });
    await createAdminRealm({
      systemDb,
      actor: { id: adminId, status: 'active', is_system_admin: 1 },
      body: { slug: 'acme', display_name: 'Acme' },
    });
    const row = await findRealmBySlug('acme');

    await deleteAdminRealm({ systemDb, actor: { id: adminId, status: 'active' }, realm: row });

    assert.equal(await findRealmBySlug('acme'), undefined);
    for (const suffix of ['', '-wal', '-shm']) {
      await assert.rejects(
        () => fs.access(path.join(realmsPath, `${row.db_file}${suffix}`)),
        (error) => {
          assert.equal(error.code, 'ENOENT');
          return true;
        }
      );
    }
  });
});

test('deleteAdminRealm rejects non-owners', async () => {
  await withRealmRegistry(async (systemDb) => {
    const adminId = await createUser(systemDb, {
      username: 'creator',
      isSystemAdmin: true,
    });
    const realmAdminId = await createUser(systemDb, { username: 'admin' });
    await createAdminRealm({
      systemDb,
      actor: { id: adminId, status: 'active', is_system_admin: 1 },
      body: { slug: 'acme', display_name: 'Acme' },
    });
    const row = await findRealmBySlug('acme');
    const realmDb = await openRealmDatabase(row);
    await realmDb.run(
      `INSERT INTO realm_memberships (user_id, status, created_at, updated_at)
       VALUES ({userId}, 'active', {now}, {now})`,
      { userId: realmAdminId, now: Date.now() }
    );
    await realmDb.run(
      `INSERT INTO membership_roles (user_id, role_id)
       SELECT {userId}, id FROM roles WHERE slug = 'realm-admin'`,
      { userId: realmAdminId }
    );

    await assert.rejects(
      () => deleteAdminRealm({ systemDb, actor: { id: realmAdminId, status: 'active' }, realm: row }),
      (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, 'forbidden');
        return true;
      }
    );
    assert.ok(await findRealmBySlug('acme'));
  });
});
