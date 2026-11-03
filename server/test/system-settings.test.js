import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  closeRealms,
  getSystemDatabase,
  initRealms,
} from '../src/lib/realm.js';
import {
  getAdminSystemSettings,
  getSystemBranding,
  updateAdminSystemSettings,
} from '../src/lib/system-settings.js';

async function withSystemDatabase(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-system-settings-'));
  try {
    await initRealms({
      database: {
        dialect: 'sqlite',
        path: path.join(dir, 'system.sqlite'),
        realms: path.join(dir, 'realms'),
      },
    });
    await fn(getSystemDatabase());
  } finally {
    await closeRealms();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('system settings expose and persist global branding', async () => {
  await withSystemDatabase(async (systemDb) => {
    assert.deepEqual(await getSystemBranding(systemDb), {});

    const initial = await getAdminSystemSettings(systemDb);
    assert.equal(initial.logo_url, null);
    assert.equal(initial.primary_color, null);
    assert.equal(typeof initial.updated_at, 'number');

    const updated = await updateAdminSystemSettings({
      systemDb,
      body: { primary_color: '#25A' },
    });
    assert.equal(updated.primary_color, '#2255aa');
    assert.equal(updated.logo_url, null);

    assert.deepEqual(await getSystemBranding(systemDb), { primary_color: '#2255aa' });
  });
});

test('system settings patch unknown branding keys and clear values', async () => {
  await withSystemDatabase(async (systemDb) => {
    await systemDb.run(
      `UPDATE system_settings
          SET branding = {branding}
        WHERE id = 1`,
      {
        branding: JSON.stringify({
          primary_color: '#2255aa',
          custom_asset: 'https://system.test/custom.png',
        }),
      }
    );

    const updated = await updateAdminSystemSettings({
      systemDb,
      body: { logo_url: 'https://system.test/logo.svg' },
    });
    assert.equal(updated.primary_color, '#2255aa');
    assert.equal(updated.logo_url, 'https://system.test/logo.svg');

    const row = await systemDb.get('SELECT branding FROM system_settings WHERE id = 1');
    assert.deepEqual(JSON.parse(row.branding), {
      primary_color: '#2255aa',
      custom_asset: 'https://system.test/custom.png',
      logo_url: 'https://system.test/logo.svg',
    });

    const cleared = await updateAdminSystemSettings({
      systemDb,
      body: { logo_url: '', primary_color: null },
    });
    assert.equal(cleared.logo_url, null);
    assert.equal(cleared.primary_color, null);
    assert.deepEqual(JSON.parse((await systemDb.get('SELECT branding FROM system_settings WHERE id = 1')).branding), {
      custom_asset: 'https://system.test/custom.png',
    });
  });
});

test('system settings validate branding input', async () => {
  await withSystemDatabase(async (systemDb) => {
    for (const body of [
      {},
      { display_name: 'Auth' },
      { primary_color: 'red' },
      { logo_url: 'http://system.test/logo.svg' },
    ]) {
      await assert.rejects(
        () => updateAdminSystemSettings({ systemDb, body }),
        (error) => {
          assert.equal(error.status, 400);
          assert.equal(error.code, 'invalid_request');
          return true;
        }
      );
    }
  });
});
