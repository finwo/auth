import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { packTar } from 'modern-tar';
import { validateTemplateArchive } from '../src/lib/template-artifact.js';

async function archive(files, { gzip = true } = {}) {
  const entries = files.map(({ name, body = '', type = 'file', linkname }) => ({
    header: {
      name,
      type,
      size: Buffer.byteLength(body),
      ...(linkname ? { linkname } : {}),
    },
    body,
  }));
  const tar = await packTar(entries);
  return gzip ? gzipSync(tar) : tar;
}

function limits(overrides = {}) {
  return {
    maxArchiveBytes: 1024 * 1024,
    maxExtractedBytes: 1024 * 1024,
    maxFiles: 16,
    ...overrides,
  };
}

test('partial overlay archives are valid', async () => {
  const buffer = await archive([
    { name: 'login/identifier.hbs', body: '<h1>Sign in</h1>' },
    { name: 'style/overlay.css', body: '.auth-card { color: red; }' },
  ]);

  assert.deepEqual(await validateTemplateArchive(buffer, limits()), {
    fileCount: 2,
    extractedBytes: 42,
  });
});

test('uncompressed template archives are valid', async () => {
  const buffer = await archive([
    { name: 'login/identifier.hbs', body: '<h1>Sign in</h1>' },
  ], { gzip: false });

  assert.deepEqual(await validateTemplateArchive(buffer, limits()), {
    fileCount: 1,
    extractedBytes: 16,
  });
});

test('template paths cannot escape the archive root', async () => {
  for (const name of ['../evil.hbs', '/evil.hbs', 'login/../../evil.hbs']) {
    const buffer = await archive([{ name, body: 'x' }]);
    await assert.rejects(
      validateTemplateArchive(buffer, limits()),
      /Invalid template path/
    );
  }
});

test('template archives reject unsupported files and entries', async () => {
  const text = await archive([{ name: 'notes.txt', body: 'x' }]);
  await assert.rejects(validateTemplateArchive(text, limits()), /file type/);

  const manifest = await archive([{ name: 'manifest.json', body: '{}' }]);
  await assert.rejects(validateTemplateArchive(manifest, limits()), /manifest\.json/);

  const symlink = await archive([
    { name: 'link.hbs', type: 'symlink', linkname: '../outside.hbs' },
  ]);
  await assert.rejects(validateTemplateArchive(symlink, limits()), /Unsupported tar entry type/);
});

test('template archives reject duplicate paths', async () => {
  const buffer = await archive([
    { name: 'login/identifier.hbs', body: 'one' },
    { name: 'LOGIN/identifier.hbs', body: 'two' },
  ]);
  await assert.rejects(validateTemplateArchive(buffer, limits()), /Duplicate template path/);
});

test('template archives enforce file and size limits', async () => {
  const files = await archive([
    { name: 'login/one.hbs', body: 'one' },
    { name: 'login/two.hbs', body: 'two' },
  ]);
  await assert.rejects(
    validateTemplateArchive(files, limits({ maxFiles: 1 })),
    /too many files/
  );

  const large = await archive([{ name: 'login/large.hbs', body: 'hello' }]);
  await assert.rejects(
    validateTemplateArchive(large, limits({ maxExtractedBytes: 4 })),
    /contents exceed/
  );
  await assert.rejects(
    validateTemplateArchive(large, limits({ maxArchiveBytes: 10 })),
    /archive exceeds/
  );
});

test('empty and malformed archives are rejected', async () => {
  const empty = await archive([{ name: 'login/', type: 'directory' }]);
  await assert.rejects(validateTemplateArchive(empty, limits()), /archive is empty/);

  await assert.rejects(
    validateTemplateArchive(Buffer.from('not a gzip archive'), limits()),
    /archive is invalid/
  );
});
