import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../app.js';
import { HttpError } from './http/http-error.js';
import {
  detectArchiveFormat,
  normalizePackagePath,
  packageExtension,
  readArchiveEntries,
} from './package-archive.js';
import {
  normalizeTemplateArtifact,
  sha256Hex,
} from './template-artifact.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUILTIN_TEMPLATE_ROOT = path.resolve(here, '../../../dist/templates');
export const TEMPLATE_PACKAGE_TYPE = 'template-v1';

const packagePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const typePattern = /^[a-z][a-z0-9-]*-v[0-9]+$/;
const maxManifestBytes = 64 * 1024;
const maxLayersPerRealm = 16;

const templateExtensions = new Set([
  '.hbs',
  '.css',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]);

const packageExtensions = new Set([
  ...templateExtensions,
  '.json',
  '.tar',
  '.tar.gz',
  '.tgz',
]);

const templateArtifactExtensions = new Set(['.tar', '.tar.gz', '.tgz']);
const sourceCache = new Map();

const artifactOutputs = {
  'template-v1': {
    'template.tar.gz': (_systemDb, row) => {
      const info = readTemplateInfo(row);
      return info ? packageFilePath(row.id, info.path) : null;
    },
  },
};

function artifactName(type) {
  return Object.keys(artifactOutputs[type] || {})[0] || null;
}

function invalidManifest(message) {
  return new HttpError(400, 'invalid_manifest', message);
}

function invalidPackage(message) {
  return new HttpError(400, 'invalid_package', message);
}

function invalidRequest(message) {
  return new HttpError(400, 'invalid_request', message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalidManifest(`${label} contains an unsupported field: ${key}`);
    }
  }
}

function normalizePackageType(value) {
  if (typeof value !== 'string') throw invalidManifest('manifest type is required');
  const type = value.trim();
  if (!typePattern.test(type)) {
    throw invalidManifest('manifest type must be a versioned lowercase identifier');
  }
  return type;
}

function normalizeTextField(value, { name, max, required = true, code = 'invalid_manifest' }) {
  const hasValue = value !== undefined && value !== null && String(value).trim() !== '';
  if (!hasValue) {
    if (required) {
      const fail = code === 'invalid_request' ? invalidRequest : invalidManifest;
      throw fail(`${name} is required`);
    }
    return null;
  }

  const text = String(value).trim();
  if (text.length > max) {
    const fail = code === 'invalid_request' ? invalidRequest : invalidManifest;
    throw fail(`${name} is too long`);
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    const fail = code === 'invalid_request' ? invalidRequest : invalidManifest;
    throw fail(`${name} contains invalid characters`);
  }
  return text;
}

function normalizeEmail(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const email = String(value).trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw invalidManifest('author email is invalid');
  }
  return email;
}

function parseAuthor(value) {
  if (!plainObject(value)) throw invalidManifest('author is required');
  rejectUnknownKeys(value, ['name', 'email'], 'author');
  return {
    name: normalizeTextField(value.name, { name: 'author name', max: 80 }),
    email: normalizeEmail(value.email),
  };
}

function normalizedArtifactPath(value) {
  const normalized = normalizePackagePath(value, { allowAbsolute: true });
  const extension = packageExtension(normalized);
  if (!templateArtifactExtensions.has(extension)) {
    throw invalidManifest('template package must point to a tar or tar.gz file');
  }
  if (extension === '.tar') return `${normalized.slice(0, -4)}.tar.gz`;
  if (extension === '.tgz') return `${normalized.slice(0, -4)}.tar.gz`;
  return normalized;
}

function parsePackageManifest(buffer) {
  if (!buffer || buffer.length > maxManifestBytes) {
    throw invalidManifest('manifest.json is missing or too large');
  }

  let value;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    value = JSON.parse(text);
  } catch {
    throw invalidManifest('manifest.json is not valid JSON');
  }

  if (!plainObject(value)) throw invalidManifest('manifest.json must contain an object');
  const type = normalizePackageType(value.type);

  if (type === TEMPLATE_PACKAGE_TYPE) {
    rejectUnknownKeys(value, ['type', 'author', 'template'], 'manifest.json');
    if (!plainObject(value.template)) throw invalidManifest('template is required');
    rejectUnknownKeys(value.template, ['name', 'version', 'package'], 'template');

    const author = parseAuthor(value.author);
    return {
      type,
      name: normalizeTextField(value.template.name, { name: 'template name', max: 80 }),
      version: normalizeTextField(value.template.version, { name: 'template version', max: 40 }),
      author,
      artifactPath: normalizedArtifactPath(value.template.package),
      originalArtifactPath: normalizePackagePath(value.template.package, { allowAbsolute: true }),
    };
  }

  const packageValue = plainObject(value.package) ? value.package : null;
  const authorValue = plainObject(value.author) ? value.author : null;
  const author = {
    name: authorValue
      ? normalizeTextField(authorValue.name, {
          name: 'author name',
          max: 80,
          required: false,
        }) || 'Unknown'
      : 'Unknown',
    email: authorValue ? normalizeEmail(authorValue.email) : null,
  };

  return {
    type,
    name:
      normalizeTextField(packageValue?.name ?? value.name, {
        name: 'package name',
        max: 80,
        required: false,
      }) || type,
    version:
      normalizeTextField(packageValue?.version ?? value.version, {
        name: 'package version',
        max: 40,
        required: false,
      }) || '0',
    author,
  };
}

function templateManifestText(info, artifactPath) {
  const manifest = {
    type: TEMPLATE_PACKAGE_TYPE,
    author: { name: info.author.name },
    template: {
      name: info.name,
      version: info.version,
      package: `/${artifactPath}`,
    },
  };
  if (info.author.email) manifest.author.email = info.author.email;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function packageLimits() {
  return {
    maxArchiveBytes: app.config.packages.max_archive_bytes,
    maxExtractedBytes: app.config.packages.max_extracted_bytes,
    maxFiles: app.config.packages.max_files,
  };
}

export function packageRoot() {
  return path.resolve(app.config.packages.path);
}

export function packageDirectory(id) {
  if (!packagePattern.test(String(id))) throw invalidPackage('Invalid package id');
  return path.join(packageRoot(), id);
}

function packageManifestPath(id) {
  return path.join(packageDirectory(id), 'manifest.json');
}

function packageFilePath(id, relativePath) {
  const directory = packageDirectory(id);
  const normalized = normalizePackagePath(relativePath, { allowAbsolute: false });
  const resolved = path.resolve(directory, normalized);
  if (resolved !== directory && !resolved.startsWith(directory + path.sep)) {
    throw invalidPackage('Invalid package path');
  }
  return resolved;
}

function cacheSource(id, value) {
  sourceCache.set(id, value);
  if (sourceCache.size > 256) {
    sourceCache.delete(sourceCache.keys().next().value);
  }
  return value;
}

function clearSourceCache(id) {
  sourceCache.delete(id);
}

function readTemplateInfo(row) {
  const cached = sourceCache.get(row.id);
  if (cached) return cached;

  let manifestBuffer;
  try {
    manifestBuffer = fs.readFileSync(packageManifestPath(row.id));
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = parsePackageManifest(manifestBuffer);
  } catch {
    return null;
  }
  if (parsed.type !== TEMPLATE_PACKAGE_TYPE || !parsed.artifactPath) return null;

  let archive;
  let file;
  try {
    file = packageFilePath(row.id, parsed.artifactPath);
    archive = fs.readFileSync(file);
  } catch {
    return null;
  }

  return cacheSource(row.id, {
    label: `${row.name} ${row.version}`,
    path: parsed.artifactPath,
    digest: sha256Hex(archive),
  });
}

function serializePackage(row) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    version: row.version,
    author_name: row.author_name,
    author_email: row.author_email || null,
    digest: row.digest,
    byte_size: row.byte_size,
    file_count: row.file_count,
    filename: row.filename || null,
    created_at: row.created_at,
    template_count: Number(row.template_count ?? 0),
    template: readTemplateInfo(row),
  };
}

function serializeAssignedPackage(row) {
  const info = readTemplateInfo(row);
  return {
    id: row.id,
    label: info?.label || `${row.name} ${row.version}`,
    name: row.name,
    version: row.version,
    author_name: row.author_name,
    author_email: row.author_email || null,
    digest: info?.digest || null,
    byte_size: row.byte_size,
    file_count: row.file_count,
    filename: row.filename || null,
    created_at: row.created_at,
    position: Number(row.position),
    realm_count: Number(row.realm_count ?? 0),
  };
}

async function writePackageFiles(id, entries, originalBuffer, format) {
  const root = packageRoot();
  const directory = packageDirectory(id);
  const temp = path.join(root, `${id}.${crypto.randomUUID()}.tmp`);
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(temp);

  try {
    for (const [entryName, body] of entries.entries()) {
      const target = path.resolve(temp, normalizePackagePath(entryName, { allowAbsolute: false }));
      if (!target.startsWith(temp + path.sep)) throw invalidPackage('Invalid package path');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, body, { flag: 'wx' });
    }

    if (originalBuffer) {
      const extension = format === 'zip' ? 'zip' : format === 'gzip' ? 'tar.gz' : 'tar';
      await fsp.writeFile(path.join(temp, `.package.${extension}`), originalBuffer, { flag: 'wx' });
    }

    await fsp.rename(temp, directory);
  } catch (error) {
    await fsp.rm(temp, { recursive: true, force: true });
    throw error;
  }
}

async function processPackage(buffer) {
  const archive = await readArchiveEntries(buffer, {
    ...packageLimits(),
    allowedExtensions: packageExtensions,
    allowAbsolute: true,
  });

  const manifestBuffer = archive.entries.get('manifest.json');
  if (!manifestBuffer) throw invalidPackage('The package is missing manifest.json');
  const manifest = parsePackageManifest(manifestBuffer);

  if (manifest.type !== TEMPLATE_PACKAGE_TYPE) {
    return { format: archive.format, manifest, entries: archive.entries, fileCount: archive.fileCount };
  }

  const artifactPath = manifest.artifactPath;
  const originalPath = manifest.originalArtifactPath;
  const artifactBuffer = archive.entries.get(originalPath);
  if (!artifactBuffer) {
    throw invalidManifest('The template package file is missing from the archive');
  }

  const allowed = new Set([
    'manifest.json'.toLowerCase(),
    normalizePackagePath(originalPath, { allowAbsolute: false }).toLowerCase(),
  ]);
  for (const entryName of archive.entries.keys()) {
    if (!allowed.has(entryName.toLowerCase())) {
      throw invalidPackage(`Unexpected file in template package: ${entryName}`);
    }
  }

  const artifact = await normalizeTemplateArtifact(artifactBuffer, packageLimits());
  const rewritten = templateManifestText(manifest, artifactPath);
  const entries = new Map([
    ['manifest.json', Buffer.from(rewritten)],
    [artifactPath, artifact.buffer],
  ]);

  return { format: archive.format, manifest, entries, fileCount: archive.fileCount };
}

async function insertPackageRow(systemDb, { id, manifest, digest, byteSize, fileCount, filename, createdBy }) {
  const createdAt = Date.now();
  await systemDb.run(
    `INSERT INTO packages
      (id, type, name, version, author_name, author_email, digest, byte_size, file_count, filename, created_by, created_at)
     VALUES
      ({id}, {type}, {name}, {version}, {authorName}, {authorEmail}, {digest}, {byteSize}, {fileCount}, {filename}, {createdBy}, {createdAt})`,
    {
      id,
      type: manifest.type,
      name: manifest.name,
      version: manifest.version,
      authorName: manifest.author.name,
      authorEmail: manifest.author.email,
      digest,
      byteSize,
      fileCount,
      filename,
      createdBy,
      createdAt,
    }
  );
}

async function createPackageFromProcessed(systemDb, { buffer, processed, userId, filename = null }) {
  const digest = sha256Hex(buffer);
  const existing = await systemDb.get('SELECT id FROM packages WHERE digest = {digest}', { digest });
  if (existing) {
    throw new HttpError(409, 'package_exists', 'This package archive has already been uploaded');
  }

  const id = crypto.randomUUID();
  await writePackageFiles(id, processed.entries, buffer, processed.format);
  try {
    await insertPackageRow(systemDb, {
      id,
      manifest: processed.manifest,
      digest,
      byteSize: buffer.byteLength,
      fileCount: processed.fileCount,
      filename,
      createdBy: userId,
    });
  } catch (error) {
    await fsp.rm(packageDirectory(id), { recursive: true, force: true });
    throw error;
  }

  clearSourceCache(id);
  return getPackage(systemDb, id);
}

export async function uploadPackage(systemDb, { buffer, userId, filename = null }) {
  const processed = await processPackage(buffer);
  return createPackageFromProcessed(systemDb, { buffer, processed, userId, filename });
}

export async function uploadTemplatePackage(systemDb, { buffer, userId, filename = null }) {
  const processed = await processPackage(buffer);
  if (processed.manifest.type !== TEMPLATE_PACKAGE_TYPE) {
    throw new HttpError(422, 'not_template_package', 'The uploaded package is not a template');
  }
  return createPackageFromProcessed(systemDb, { buffer, processed, userId, filename });
}

export function normalizeUploadMetadata(values) {
  const author = {
    name: normalizeTextField(values.author_name, {
      name: 'author_name',
      max: 80,
      code: 'invalid_request',
    }),
    email: values.author_email?.trim() ? normalizeEmail(values.author_email) : null,
  };

  return {
    type: TEMPLATE_PACKAGE_TYPE,
    name: normalizeTextField(values.name, { name: 'name', max: 80, code: 'invalid_request' }),
    version: normalizeTextField(values.version, { name: 'version', max: 40, code: 'invalid_request' }),
    author,
  };
}

export async function uploadTemplateArtifact(systemDb, { buffer, values, userId, filename = null }) {
  const manifest = normalizeUploadMetadata(values);
  const artifact = await normalizeTemplateArtifact(buffer, packageLimits());
  const existing = await systemDb.get('SELECT id FROM packages WHERE digest = {digest}', {
    digest: artifact.digest,
  });
  if (existing) {
    throw new HttpError(409, 'template_exists', 'This template archive has already been uploaded');
  }

  const artifactPath = 'template.tar.gz';
  const manifestText = templateManifestText(manifest, artifactPath);
  const entries = new Map([
    ['manifest.json', Buffer.from(manifestText)],
    [artifactPath, artifact.buffer],
  ]);

  const id = crypto.randomUUID();
  await writePackageFiles(id, entries, null, 'gzip');
  try {
    await insertPackageRow(systemDb, {
      id,
      manifest,
      digest: artifact.digest,
      byteSize: artifact.buffer.byteLength,
      fileCount: entries.size,
      filename,
      createdBy: userId,
    });
  } catch (error) {
    await fsp.rm(packageDirectory(id), { recursive: true, force: true });
    throw error;
  }

  clearSourceCache(id);
  return getPackage(systemDb, id);
}

export async function isDistributionPackage(buffer) {
  if (detectArchiveFormat(buffer) === 'zip') return true;
  try {
    const archive = await readArchiveEntries(buffer, {
      ...packageLimits(),
      allowedExtensions: packageExtensions,
      allowAbsolute: true,
    });
    return archive.entries.has('manifest.json');
  } catch {
    return false;
  }
}

export async function listPackages(systemDb) {
  const rows = await systemDb.all(
    `SELECT p.*, (
       SELECT COUNT(*) FROM realm_template_layers a WHERE a.package_id = p.id
     ) + (
       SELECT COUNT(*) FROM system_template_layers s WHERE s.package_id = p.id
     ) AS template_count
      FROM packages p
     ORDER BY p.created_at DESC, p.name ASC`
  );
  return rows.map(serializePackage);
}

export async function listTemplatePackages(systemDb) {
  const rows = await systemDb.all(
    `SELECT p.*, (
       SELECT COUNT(*) FROM realm_template_layers a WHERE a.package_id = p.id
     ) + (
       SELECT COUNT(*) FROM system_template_layers s WHERE s.package_id = p.id
     ) AS template_count
      FROM packages p
     WHERE p.type = {type}
     ORDER BY p.created_at DESC, p.name ASC`,
    { type: TEMPLATE_PACKAGE_TYPE }
  );
  return rows.map(serializePackage);
}

export async function getPackage(systemDb, id) {
  const row = await systemDb.get(
    `SELECT p.*, (
       SELECT COUNT(*) FROM realm_template_layers a WHERE a.package_id = p.id
     ) + (
       SELECT COUNT(*) FROM system_template_layers s WHERE s.package_id = p.id
     ) AS template_count
      FROM packages p WHERE p.id = {id}`,
    { id }
  );
  return row ? serializePackage(row) : null;
}

export async function getTemplatePackage(systemDb, id) {
  const row = await systemDb.get(
    `SELECT p.*, (
       SELECT COUNT(*) FROM realm_template_layers a WHERE a.package_id = p.id
     ) + (
       SELECT COUNT(*) FROM system_template_layers s WHERE s.package_id = p.id
     ) AS template_count
      FROM packages p WHERE p.id = {id} AND p.type = {type}`,
    { id, type: TEMPLATE_PACKAGE_TYPE }
  );
  return row ? serializePackage(row) : null;
}

export async function deletePackage(systemDb, id) {
  const row = await systemDb.transaction(async (tx) => {
    const packageRow = await tx.get('SELECT id FROM packages WHERE id = {id}', { id });
    if (!packageRow) {
      throw new HttpError(404, 'package_not_found', 'Package not found');
    }

    const assigned = await tx.get(
      `SELECT (
         SELECT COUNT(*) FROM realm_template_layers WHERE package_id = {id}
       ) + (
         SELECT COUNT(*) FROM system_template_layers WHERE package_id = {id}
       ) AS count`,
      { id }
    );
    if (Number(assigned.count) > 0) {
      throw new HttpError(409, 'package_assigned', 'The package is assigned to a realm');
    }

    await tx.run('DELETE FROM packages WHERE id = {id}', { id });
    return packageRow;
  });

  await fsp.rm(packageDirectory(row.id), { recursive: true, force: true });
  clearSourceCache(row.id);
}

export async function deleteTemplatePackage(systemDb, id) {
  const row = await systemDb.get('SELECT id FROM packages WHERE id = {id} AND type = {type}', {
    id,
    type: TEMPLATE_PACKAGE_TYPE,
  });
  if (!row) {
    throw new HttpError(404, 'template_not_found', 'Template not found');
  }
  await deletePackage(systemDb, id);
}

function normalizeTemplatePackageIds(packageIds) {
  const ids = Array.isArray(packageIds) ? packageIds : null;
  if (!ids) throw invalidRequest('package_ids must be an array');
  if (ids.length > maxLayersPerRealm) throw invalidRequest('Too many template layers');

  const unique = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !packagePattern.test(id)) {
      throw invalidRequest('package_ids must contain package IDs');
    }
    if (unique.has(id)) throw invalidRequest('package_ids must not contain duplicates');
    unique.add(id);
  }
  return ids;
}

async function assertTemplatePackages(systemDb, ids) {
  for (const id of ids) {
    const row = await systemDb.get('SELECT * FROM packages WHERE id = {id} AND type = {type}', {
      id,
      type: TEMPLATE_PACKAGE_TYPE,
    });
    if (!row) throw new HttpError(400, 'package_not_template', 'Only template packages can be assigned');
    if (!readTemplateInfo(row)) {
      throw new HttpError(400, 'invalid_package', 'The assigned package template file is unavailable');
    }
  }
}

export async function listRealmTemplateLayers(systemDb, realmId) {
  const rows = await systemDb.all(
    `SELECT p.*, a.position, (
       SELECT COUNT(*) FROM realm_template_layers r WHERE r.package_id = p.id
     ) + (
       SELECT COUNT(*) FROM system_template_layers s WHERE s.package_id = p.id
     ) AS realm_count
      FROM realm_template_layers a
      JOIN packages p ON p.id = a.package_id AND p.type = {type}
     WHERE a.realm_id = {realmId}
     ORDER BY a.position ASC`,
    { realmId, type: TEMPLATE_PACKAGE_TYPE }
  );
  return rows.map(serializeAssignedPackage);
}

export async function listSystemTemplateLayers(systemDb) {
  const rows = await systemDb.all(
    `SELECT p.*, a.position, (
       SELECT COUNT(*) FROM realm_template_layers r WHERE r.package_id = p.id
     ) + (
       SELECT COUNT(*) FROM system_template_layers s WHERE s.package_id = p.id
     ) AS realm_count
      FROM system_template_layers a
      JOIN packages p ON p.id = a.package_id AND p.type = {type}
     ORDER BY a.position ASC`,
    { type: TEMPLATE_PACKAGE_TYPE }
  );
  return rows.map(serializeAssignedPackage);
}

export async function replaceRealmTemplateLayers(systemDb, { realmId, packageIds }) {
  const ids = normalizeTemplatePackageIds(packageIds);
  await assertTemplatePackages(systemDb, ids);

  await systemDb.transaction(async (tx) => {
    await tx.run('DELETE FROM realm_template_layers WHERE realm_id = {realmId}', { realmId });
    for (let position = 0; position < ids.length; position += 1) {
      await tx.run(
        `INSERT INTO realm_template_layers (realm_id, package_id, position)
         VALUES ({realmId}, {packageId}, {position})`,
        { realmId, packageId: ids[position], position }
      );
    }
  });

  return listRealmTemplateLayers(systemDb, realmId);
}

export async function replaceSystemTemplateLayers(systemDb, { packageIds }) {
  const ids = normalizeTemplatePackageIds(packageIds);
  await assertTemplatePackages(systemDb, ids);

  await systemDb.transaction(async (tx) => {
    await tx.run('DELETE FROM system_template_layers');
    for (let position = 0; position < ids.length; position += 1) {
      await tx.run(
        `INSERT INTO system_template_layers (package_id, position)
         VALUES ({packageId}, {position})`,
        { packageId: ids[position], position }
      );
    }
  });

  return listSystemTemplateLayers(systemDb);
}

export function builtinTemplateArchivePath(digest) {
  return path.join(BUILTIN_TEMPLATE_ROOT, `${digest}.tar.gz`);
}

export function builtinTemplateManifest() {
  const value = JSON.parse(fs.readFileSync(path.join(BUILTIN_TEMPLATE_ROOT, 'manifest.json'), 'utf8'));
  if (!value || value.api !== 1 || !value.base) {
    throw new Error('Template base manifest is invalid');
  }
  return value;
}

async function ensureSystemBasePackage(systemDb) {
  const base = builtinTemplateManifest().base;
  const archiveBuffer = fs.readFileSync(builtinTemplateArchivePath(base.digest));
  const version = base.digest.slice(0, 12);
  const existing = await systemDb.get(
    "SELECT id, digest FROM packages WHERE name = 'system-template' LIMIT 1"
  );

  if (existing && existing.digest === base.digest) {
    try {
      fs.accessSync(packageFilePath(existing.id, 'template.tar.gz'));
      return existing.id;
    } catch {}
  }

  const manifest = {
    type: TEMPLATE_PACKAGE_TYPE,
    name: 'system-template',
    version,
    author: { name: 'System' },
  };
  const entries = new Map([
    ['manifest.json', Buffer.from(templateManifestText(manifest, 'template.tar.gz'))],
    ['template.tar.gz', archiveBuffer],
  ]);

  if (existing) {
    await fsp.rm(packageDirectory(existing.id), { recursive: true, force: true });
    await writePackageFiles(existing.id, entries, null, 'gzip');
    await systemDb.run(
      `UPDATE packages
          SET type = {type}, name = 'system-template', version = {version},
              author_name = 'System', digest = {digest}, byte_size = {size}, file_count = {fileCount}
        WHERE id = {id}`,
      {
        id: existing.id,
        type: TEMPLATE_PACKAGE_TYPE,
        version,
        digest: base.digest,
        size: archiveBuffer.byteLength,
        fileCount: entries.size,
      }
    );
    clearSourceCache(existing.id);
    return existing.id;
  }

  const user = await systemDb.get(
    'SELECT id FROM users WHERE is_system_admin = 1 ORDER BY created_at ASC LIMIT 1'
  );
  if (!user) throw new HttpError(503, 'template_build_missing', 'No user exists for the system base package');

  const id = crypto.randomUUID();
  await writePackageFiles(id, entries, null, 'gzip');
  try {
    await systemDb.run(
      `INSERT INTO packages
        (id, type, name, version, author_name, digest, byte_size, file_count, created_by, created_at)
       VALUES
        ({id}, {type}, 'system-template', {version}, 'System', {digest}, {size}, {fileCount}, {userId}, {createdAt})`,
      {
        id,
        type: TEMPLATE_PACKAGE_TYPE,
        version,
        digest: base.digest,
        size: archiveBuffer.byteLength,
        fileCount: entries.size,
        userId: user.id,
        createdAt: Date.now(),
      }
    );
  } catch (error) {
    await fsp.rm(packageDirectory(id), { recursive: true, force: true });
    throw error;
  }
  clearSourceCache(id);
  return id;
}

export async function templateConfigLayers(systemDb, context) {
  const baseId = await ensureSystemBasePackage(systemDb);
  const base = builtinTemplateManifest().base;
  const rows = await systemDb.all(
    `SELECT p.*, a.position, 'system' AS scope
       FROM system_template_layers a
       JOIN packages p ON p.id = a.package_id AND p.type = {type}
      UNION ALL
     SELECT p.*, a.position, 'realm' AS scope
       FROM realm_template_layers a
       JOIN packages p ON p.id = a.package_id AND p.type = {type}
      WHERE a.realm_id = {realmId}
      ORDER BY scope DESC, position ASC`,
    { realmId: context.realm?.id || '', type: TEMPLATE_PACKAGE_TYPE }
  );

  const layers = [
    {
      digest: base.digest,
      url: `/api/v1/packages/${baseId}/template.tar.gz`,
    },
  ];

  for (const row of rows) {
    const info = readTemplateInfo(row);
    if (!info) continue;
    layers.push({
      digest: info.digest,
      url: `/api/v1/packages/${encodeURIComponent(row.id)}/template.tar.gz`,
    });
  }

  return layers;
}

export async function effectiveTemplateManifest(systemDb, context, base = builtinTemplateManifest()) {
  const rows = await systemDb.all(
    `SELECT p.*, a.position, 'system' AS scope
       FROM system_template_layers a
       JOIN packages p ON p.id = a.package_id AND p.type = {type}
      UNION ALL
     SELECT p.*, a.position, 'realm' AS scope
       FROM realm_template_layers a
       JOIN packages p ON p.id = a.package_id AND p.type = {type}
      WHERE a.realm_id = {realmId}
      ORDER BY scope DESC, position ASC`,
    { realmId: context.realm?.id || '', type: TEMPLATE_PACKAGE_TYPE }
  );

  const overlays = [];
  for (const row of rows) {
    const info = readTemplateInfo(row);
    if (!info) continue;
    overlays.push({ digest: info.digest });
  }

  return {
    api: 1,
    base: { ...base.base },
    overlays,
  };
}

export async function resolvePackageArtifactFile(systemDb, packageId, filename) {
  if (!packagePattern.test(packageId)) return null;

  const row = await systemDb.get('SELECT * FROM packages WHERE id = {id}', { id: packageId });
  if (!row) return null;

  const render = artifactOutputs[row.type]?.[filename];
  return render ? render(systemDb, row) : null;
}

export async function findTemplateFileByDigest(systemDb, digest) {
  const rows = await systemDb.all(
    'SELECT * FROM packages WHERE type = {type}',
    { type: TEMPLATE_PACKAGE_TYPE }
  );
  for (const row of rows) {
    const info = readTemplateInfo(row);
    if (info?.digest === digest) return packageFilePath(row.id, info.path);
  }
  return null;
}

export async function resolvePackageTemplateFile(systemDb, packageId, requestedPath) {
  if (!packagePattern.test(packageId)) return null;
  const row = await systemDb.get('SELECT * FROM packages WHERE id = {id} AND type = {type}', {
    id: packageId,
    type: TEMPLATE_PACKAGE_TYPE,
  });
  if (!row) return null;

  let relativePath;
  try {
    relativePath = normalizePackagePath(requestedPath, { allowAbsolute: false });
  } catch {
    return null;
  }

  const info = readTemplateInfo(row);
  if (!info || info.path !== relativePath) return null;

  const file = packageFilePath(packageId, info.path);
  if (!fs.existsSync(file)) return null;
  return file;
}

export function isPackageId(value) {
  return packagePattern.test(String(value));
}

export function packageArchiveFormat(buffer) {
  return detectArchiveFormat(buffer);
}
