import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/lib/config.js';

async function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AUTH_')) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('AUTH_')) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

async function inTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-cfg-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('sqlite defaults load without any configuration', async () => {
  await inTempDir(() =>
    withEnv({}, () => {
      const cfg = loadConfig();
      assert.equal(cfg.database.dialect, 'sqlite');
      assert.equal(cfg.database.path, './data/system.sqlite');
      assert.equal(cfg.database.realms, './data/realms');
      assert.equal(cfg.templates.path, './data/templates');
      assert.equal(cfg.templates.max_archive_bytes, 2097152);
      assert.equal(cfg.templates.max_extracted_bytes, 10485760);
      assert.equal(cfg.templates.max_files, 256);
    })
  );
});

test('an explicit null database path is rejected', async () => {
  await inTempDir(async () => {
    await fs.writeFile('auth.yaml', 'database:\n  path: null\n');
    await withEnv({}, () => {
      assert.throws(() => loadConfig(), /database\.path/);
    });
  });
});

test('sqlite configuration loads with both paths', async () => {
  await inTempDir(() =>
    withEnv(
      {
        AUTH_DATABASE_DIALECT: 'sqlite',
        AUTH_DATABASE_PATH: './data/system.sqlite',
        AUTH_REALMS_PATH: './data/realms',
      },
      () => {
        const cfg = loadConfig();
        assert.equal(cfg.database.dialect, 'sqlite');
        assert.equal(cfg.database.path, './data/system.sqlite');
        assert.equal(cfg.database.realms, './data/realms');
        assert.throws(() => {
          cfg.server.port = 1;
        }, TypeError);
      }
    )
  );
});

test('an unsupported dialect is rejected', async () => {
  await inTempDir(() =>
    withEnv(
      {
        AUTH_DATABASE_DIALECT: 'mysql',
        AUTH_DATABASE_PATH: './data/system.sqlite',
        AUTH_REALMS_PATH: './data/realms',
      },
      () => {
        assert.throws(() => loadConfig(), /database\.dialect/);
      }
    )
  );
});

test('template settings load from environment variables', async () => {
  await inTempDir(() =>
    withEnv(
      {
        AUTH_TEMPLATES_PATH: './data/themes',
        AUTH_TEMPLATE_MAX_ARCHIVE_BYTES: '1024',
        AUTH_TEMPLATE_MAX_EXTRACTED_BYTES: '4096',
        AUTH_TEMPLATE_MAX_FILES: '8',
      },
      () => {
        const cfg = loadConfig();
        assert.equal(cfg.templates.path, './data/themes');
        assert.equal(cfg.templates.max_archive_bytes, 1024);
        assert.equal(cfg.templates.max_extracted_bytes, 4096);
        assert.equal(cfg.templates.max_files, 8);
      }
    )
  );
});

test('template limits must be positive integers', async () => {
  await inTempDir(() =>
    withEnv({ AUTH_TEMPLATE_MAX_FILES: '0' }, () => {
      assert.throws(() => loadConfig(), /templates\.max_files/);
    })
  );
});

test('a non-integer port names the environment variable', async () => {
  await inTempDir(() =>
    withEnv(
      {
        AUTH_DATABASE_PATH: './data/system.sqlite',
        AUTH_REALMS_PATH: './data/realms',
        AUTH_PORT: 'http',
      },
      () => {
        assert.throws(() => loadConfig(), /AUTH_PORT/);
      }
    )
  );
});

test('static app origins are origins without paths', async () => {
  await inTempDir(() =>
    withEnv(
      {
        AUTH_DATABASE_PATH: './data/system.sqlite',
        AUTH_REALMS_PATH: './data/realms',
        AUTH_ADMIN_APP_URL: 'https://admin.example.com',
        AUTH_ACCOUNT_APP_URL: 'https://account.example.com/app',
      },
      () => {
        assert.throws(() => loadConfig(), /apps\.account/);
      }
    )
  );
});

test('environment variables override the YAML file', async () => {
  await inTempDir(async () => {
    await fs.writeFile(
      'auth.yaml',
      [
        'server:',
        '  port: 9999',
        'database:',
        '  dialect: sqlite',
        '  path: ./file/system.sqlite',
        '  realms: ./file/realms',
        '',
      ].join('\n')
    );

    await withEnv({ AUTH_PORT: '7777', AUTH_DATABASE_PATH: './env/system.sqlite' }, () => {
      const cfg = loadConfig();
      assert.equal(cfg.server.port, 7777);
      assert.equal(cfg.database.path, './env/system.sqlite');
      assert.equal(cfg.database.realms, './file/realms');
    });
  });
});
