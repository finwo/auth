import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { createTarDecoder } from 'modern-tar';
import { app } from '../app.js';
import { HttpError } from './http/http-error.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const builtinRoot = path.resolve(here, '../../../app/login/dist/templates');
const maxLayersPerRealm = 16;

export const TEMPLATE_LIMITS = Object.freeze({
  maxArchiveBytes: 2 * 1024 * 1024,
  maxExtractedBytes: 10 * 1024 * 1024,
  maxFiles: 256,
});

const allowedExtensions = new Set([
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

function templateStore() {
  return path.resolve(app.config.templates.path);
}

export function templateArchivePath(digest) {
  return path.join(templateStore(), `${digest}.tar.gz`);
}

export function builtinTemplateArchivePath(digest) {
  return path.join(builtinRoot, `${digest}.tar.gz`);
}

export function builtinTemplateManifest() {
  const value = JSON.parse(fs.readFileSync(path.join(builtinRoot, 'manifest.json'), 'utf8'));
  if (!value || value.api !== 1 || !value.base) {
    throw new Error('Template base manifest is invalid');
  }
  return value;
}

export function templateDigest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function normalizeTemplateLabel(value) {
  const label = String(value || '').trim();
  if (!label) {
    throw new HttpError(400, 'invalid_request', 'A template label is required');
  }
  if (label.length > 80) {
    throw new HttpError(400, 'invalid_request', 'The template label is too long');
  }
  if (/[\u0000-\u001f\u007f]/.test(label)) {
    throw new HttpError(400, 'invalid_request', 'The template label contains invalid characters');
  }
  return label;
}

function normalizeTemplatePath(value) {
  const input = String(value || '').replace(/\\/g, '/');
  if (!input || input.includes('\0') || input.startsWith('/')) {
    throw new HttpError(400, 'invalid_template', `Invalid template path: ${value}`);
  }

  const parts = [];
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new HttpError(400, 'invalid_template', `Invalid template path: ${value}`);
    }
    parts.push(part);
  }

  if (parts.length === 0) {
    throw new HttpError(400, 'invalid_template', `Invalid template path: ${value}`);
  }
  return parts.join('/');
}

function extensionOf(value) {
  const name = value.slice(value.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

async function consumedBytes(body, current, limit) {
  const reader = body.getReader();
  let total = current;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(413, 'template_too_large', 'The template contents exceed the size limit');
    }
  }
}

export async function validateTemplateArchive(buffer, options = {}) {
  const limits = {
    maxArchiveBytes: options.maxArchiveBytes ?? TEMPLATE_LIMITS.maxArchiveBytes,
    maxExtractedBytes: options.maxExtractedBytes ?? TEMPLATE_LIMITS.maxExtractedBytes,
    maxFiles: options.maxFiles ?? TEMPLATE_LIMITS.maxFiles,
  };

  if (buffer.byteLength > limits.maxArchiveBytes) {
    throw new HttpError(413, 'template_too_large', 'The template archive exceeds the size limit');
  }

  try {
    const gunzip = Readable.from(buffer).pipe(createGunzip());
    const entries = Readable.toWeb(gunzip).pipeThrough(createTarDecoder({ strict: true }));

    let fileCount = 0;
    let extractedBytes = 0;
    const seen = new Set();
    const seenFolded = new Set();

    for await (const entry of entries) {
      const type = entry.header.type || 'file';
      if (type === 'directory') {
        await entry.body.cancel();
        continue;
      }
      if (type !== 'file') {
        await entry.body.cancel();
        throw new HttpError(400, 'invalid_template', `Unsupported tar entry type: ${type}`);
      }

      const name = normalizeTemplatePath(entry.header.name);
      const folded = name.toLowerCase();

      if (name === 'manifest.json') {
        throw new HttpError(400, 'invalid_template', 'Template archives must not contain manifest.json');
      }
      if (!allowedExtensions.has(extensionOf(name))) {
        throw new HttpError(400, 'invalid_template', `Template file type is not allowed: ${name}`);
      }
      if (seen.has(name) || seenFolded.has(folded)) {
        throw new HttpError(400, 'invalid_template', `Duplicate template path: ${name}`);
      }

      seen.add(name);
      seenFolded.add(folded);
      fileCount += 1;

      if (fileCount > limits.maxFiles) {
        throw new HttpError(413, 'template_too_large', 'The template contains too many files');
      }

      extractedBytes = await consumedBytes(entry.body, extractedBytes, limits.maxExtractedBytes);
    }

    if (fileCount === 0) {
      throw new HttpError(400, 'invalid_template', 'The template archive is empty');
    }

    return { fileCount, extractedBytes };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_template', 'The template archive is invalid');
  }
}

export function serializeTemplateLayer(row) {
  return {
    id: row.id,
    label: row.label,
    digest: row.digest,
    url: `/app/templates/${row.digest}.tar.gz`,
    byte_size: row.byte_size,
    file_count: row.file_count,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export async function listTemplateLayers(systemDb) {
  return systemDb.all(
    `SELECT id, label, digest, byte_size, file_count, created_by, created_at
       FROM template_layers
      ORDER BY created_at DESC, label ASC`
  );
}

export async function addTemplateLayer(systemDb, { buffer, label, userId }) {
  const normalizedLabel = normalizeTemplateLabel(label);
  const details = await validateTemplateArchive(buffer, {
    maxArchiveBytes: app.config.templates.max_archive_bytes,
    maxExtractedBytes: app.config.templates.max_extracted_bytes,
    maxFiles: app.config.templates.max_files,
  });
  const digest = templateDigest(buffer);

  const existing = await systemDb.get(
    'SELECT id FROM template_layers WHERE digest = {digest}',
    { digest }
  );
  if (existing) {
    throw new HttpError(409, 'template_exists', 'This template archive has already been uploaded');
  }

  const dir = templateStore();
  const file = templateArchivePath(digest);
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const existed = await fsp.access(file).then(
    () => true,
    () => false
  );
  await fsp.mkdir(dir, { recursive: true });

  try {
    await fsp.writeFile(temp, buffer, { flag: 'wx' });
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true });
    throw error;
  }

  const row = {
    id: crypto.randomUUID(),
    label: normalizedLabel,
    digest,
    byte_size: buffer.byteLength,
    file_count: details.fileCount,
    created_by: userId,
    created_at: Date.now(),
  };

  try {
    await systemDb.run(
      `INSERT INTO template_layers
        (id, label, digest, byte_size, file_count, created_by, created_at)
       VALUES
        ({id}, {label}, {digest}, {byteSize}, {fileCount}, {createdBy}, {createdAt})`,
      {
        id: row.id,
        label: row.label,
        digest: row.digest,
        byteSize: row.byte_size,
        fileCount: row.file_count,
        createdBy: row.created_by,
        createdAt: row.created_at,
      }
    );
  } catch (error) {
    if (!existed) await fsp.rm(file, { force: true });
    throw error;
  }

  return row;
}

export async function deleteTemplateLayer(systemDb, id) {
  const row = await systemDb.transaction(async (tx) => {
    const layer = await tx.get(
      'SELECT id, digest FROM template_layers WHERE id = {id}',
      { id }
    );
    if (!layer) {
      throw new HttpError(404, 'template_not_found', 'Template not found');
    }

    const assigned = await tx.get(
      'SELECT COUNT(*) AS count FROM realm_template_layers WHERE layer_id = {id}',
      { id }
    );
    if (Number(assigned.count) > 0) {
      throw new HttpError(409, 'template_assigned', 'The template is assigned to a realm');
    }

    await tx.run('DELETE FROM template_layers WHERE id = {id}', { id });
    return layer;
  });

  await fsp.rm(templateArchivePath(row.digest), { force: true });
}

export async function listRealmTemplateLayers(systemDb, realmId) {
  const rows = await systemDb.all(
    `SELECT t.id, t.label, t.digest, t.byte_size, t.file_count, t.created_by,
            t.created_at, a.position
       FROM realm_template_layers a
       JOIN template_layers t ON t.id = a.layer_id
      WHERE a.realm_id = {realmId}
      ORDER BY a.position ASC`,
    { realmId }
  );

  return rows.map((row) => ({
    ...serializeTemplateLayer(row),
    position: row.position,
  }));
}

export async function replaceRealmTemplateLayers(systemDb, { realmId, layerIds }) {
  if (!Array.isArray(layerIds)) {
    throw new HttpError(400, 'invalid_request', 'layer_ids must be an array');
  }
  if (layerIds.length > maxLayersPerRealm) {
    throw new HttpError(400, 'invalid_request', 'Too many realm template layers');
  }

  const unique = new Set();
  for (const layerId of layerIds) {
    if (typeof layerId !== 'string' || !layerId) {
      throw new HttpError(400, 'invalid_request', 'layer_ids must contain template IDs');
    }
    if (unique.has(layerId)) {
      throw new HttpError(400, 'invalid_request', 'layer_ids must not contain duplicates');
    }
    unique.add(layerId);
  }

  await systemDb.transaction(async (tx) => {
    for (const layerId of layerIds) {
      const row = await tx.get(
        'SELECT id FROM template_layers WHERE id = {id}',
        { id: layerId }
      );
      if (!row) {
        throw new HttpError(404, 'template_not_found', 'Template not found');
      }
    }

    await tx.run('DELETE FROM realm_template_layers WHERE realm_id = {realmId}', { realmId });
    for (let position = 0; position < layerIds.length; position += 1) {
      await tx.run(
        `INSERT INTO realm_template_layers (realm_id, layer_id, position)
         VALUES ({realmId}, {layerId}, {position})`,
        { realmId, layerId: layerIds[position], position }
      );
    }
  });

  return listRealmTemplateLayers(systemDb, realmId);
}

export async function effectiveTemplateManifest(systemDb, context, base = builtinTemplateManifest()) {
  const overlays = context.realm
    ? await listRealmTemplateLayers(systemDb, context.realm.id)
    : [];

  return {
    api: 1,
    base: { ...base.base },
    overlays: overlays.map((layer) => ({
      id: layer.id,
      label: layer.label,
      digest: layer.digest,
      url: layer.url,
    })),
  };
}
