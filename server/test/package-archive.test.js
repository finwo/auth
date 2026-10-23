import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { packTar } from 'modern-tar';
import {
  normalizePackagePath,
  readArchiveEntries,
} from '../src/lib/package-archive.js';

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, body = '', method = 0, flags = 0 } of entries) {
    const nameBuffer = Buffer.from(name);
    const source = Buffer.from(body);
    const compressed = method === 8 ? deflateRawSync(source) : source;
    const checksum = crc32(source);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(source.length, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuffer);

    offset += local.length + nameBuffer.length + compressed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}

const extensions = new Set(['.json', '.hbs', '.tar.gz']);

function limits(overrides = {}) {
  return {
    maxArchiveBytes: 1024 * 1024,
    maxExtractedBytes: 1024 * 1024,
    maxFiles: 16,
    allowedExtensions: extensions,
    ...overrides,
  };
}

test('stored and deflated ZIP entries are read', async () => {
  const result = await readArchiveEntries(zipArchive([
    { name: 'manifest.json', body: '{}' },
    { name: 'theme.tar.gz', body: 'compressed', method: 8 },
  ]), limits());

  assert.equal(result.format, 'zip');
  assert.equal(result.fileCount, 2);
  assert.equal(result.entries.get('manifest.json').toString(), '{}');
  assert.equal(result.entries.get('theme.tar.gz').toString(), 'compressed');
});

test('gzip and plain tar packages are read', async () => {
  const tar = await packTar([
    { header: { name: 'manifest.json', size: 2 }, body: '{}' },
  ]);

  const plain = await readArchiveEntries(tar, limits());
  assert.equal(plain.entries.get('manifest.json').toString(), '{}');

  const gzipped = await readArchiveEntries(gzipSync(tar), limits());
  assert.equal(gzipped.entries.get('manifest.json').toString(), '{}');
});

test('package paths reject traversal and duplicates', async () => {
  await assert.rejects(
    readArchiveEntries(zipArchive([{ name: '../manifest.json', body: '{}' }]), limits()),
    /Invalid package path/
  );

  await assert.rejects(
    readArchiveEntries(zipArchive([
      { name: 'manifest.json', body: '{}' },
      { name: 'MANIFEST.JSON', body: '{}' },
    ]), limits()),
    /Duplicate package path/
  );
});

test('package archives reject unsafe or unsupported ZIP entries', async () => {
  await assert.rejects(
    readArchiveEntries(zipArchive([
      { name: 'manifest.json', body: '{}', flags: 1 },
    ]), limits()),
    /Encrypted ZIP/
  );

  await assert.rejects(
    readArchiveEntries(zipArchive([
      { name: 'manifest.json', body: '{}', method: 99 },
    ]), limits()),
    /compression method/
  );

  await assert.rejects(
    readArchiveEntries(zipArchive([
      { name: 'script.js', body: 'x' },
    ]), limits()),
    /file type/
  );
});

test('package limits apply to ZIP entries', async () => {
  await assert.rejects(
    readArchiveEntries(zipArchive([
      { name: 'manifest.json', body: '{}' },
      { name: 'theme.tar.gz', body: 'x' },
    ]), limits({ maxFiles: 1 })),
    /too many files/
  );

  await assert.rejects(
    readArchiveEntries(zipArchive([
      { name: 'manifest.json', body: '{}' },
    ]), limits({ maxArchiveBytes: 10 })),
    /archive exceeds/
  );

  await assert.rejects(
    readArchiveEntries(zipArchive([
      { name: 'manifest.json', body: 'x'.repeat(20) },
    ]), limits({ maxExtractedBytes: 10 })),
    /contents exceed/
  );
});

test('package paths may be absolute but normalize to the package root', () => {
  assert.equal(normalizePackagePath('/theme.tar.gz'), 'theme.tar.gz');
  assert.equal(normalizePackagePath('themes/./theme.tar.gz'), 'themes/theme.tar.gz');
  assert.throws(() => normalizePackagePath('/../theme.tar.gz'), /Invalid package path/);
});
