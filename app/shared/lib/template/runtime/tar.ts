import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { createTarDecoder } from 'modern-tar';
import { TemplateCache } from './cache';
import { extensionOf, normalizePath } from './paths';
import type { TemplateLayer, LogFn } from './types';

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 256;
const ALLOWED_EXTENSIONS = new Set([
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

export async function sha256Hex(data: ArrayBuffer | Uint8Array) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = crypto.subtle?.digest
    ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    : nobleSha256(bytes);
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function allowedFile(path: string) {
  return ALLOWED_EXTENSIONS.has(extensionOf(path));
}

async function ensureLayer(layer: TemplateLayer, cache: TemplateCache, log: LogFn) {
  if (await cache.hasLayer(layer.digest)) {
    log('cache', `${layer.digest.slice(0, 12)}: cached`);
    return;
  }

  log('network', `${layer.digest.slice(0, 12)}: downloading`);
  const response = await fetch(layer.url, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`${layer.digest.slice(0, 12)}: download failed with ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`${layer.digest.slice(0, 12)}: archive exceeds the size limit`);
  }

  const actualDigest = await sha256Hex(buffer);
  if (actualDigest !== layer.digest) {
    throw new Error(
      `${layer.digest.slice(0, 12)}: digest mismatch, expected ${layer.digest}, got ${actualDigest}`
    );
  }

  await cache.prepareLayer(layer.digest);

  try {
    const compressed = new Response(buffer).body;
    if (!compressed) throw new Error(`${layer.digest.slice(0, 12)}: empty response`);

    const tar = compressed.pipeThrough(new DecompressionStream('gzip'));
    const decoder = createTarDecoder({ strict: true });
    const entries = tar.pipeThrough(decoder);

    let fileCount = 0;
    let extractedBytes = 0;
    const seen = new Set<string>();
    const seenFolded = new Set<string>();

    for await (const entry of entries) {
      const type = entry.header.type || 'file';
      if (type === 'directory') {
        await entry.body.cancel();
        continue;
      }
      if (type !== 'file') {
        await entry.body.cancel();
        throw new Error(`${layer.digest.slice(0, 12)}: unsupported tar entry type ${type}`);
      }

      const path = normalizePath(entry.header.name);
      const folded = path.toLowerCase();

      if (!allowedFile(path)) {
        throw new Error(`${layer.digest.slice(0, 12)}: file type is not allowed: ${path}`);
      }
      if (seen.has(path) || seenFolded.has(folded)) {
        throw new Error(`${layer.digest.slice(0, 12)}: duplicate path: ${path}`);
      }
      seen.add(path);
      seenFolded.add(folded);

      const data = new Uint8Array(await new Response(entry.body).arrayBuffer());
      extractedBytes += data.byteLength;
      fileCount += 1;

      if (extractedBytes > MAX_EXTRACTED_BYTES) {
        throw new Error(`${layer.digest.slice(0, 12)}: extracted contents exceed the size limit`);
      }
      if (fileCount > MAX_FILES) {
        throw new Error(`${layer.digest.slice(0, 12)}: archive contains too many files`);
      }

      await cache.writeFile(layer.digest, path, data);
    }

    await cache.finishLayer(layer.digest, { source: layer.url });
    log('network', `${layer.digest.slice(0, 12)}: installed (${fileCount} files)`);
  } catch (error) {
    await cache.removeLayer(layer.digest);
    throw error;
  }
}

export async function prepareLayers(
  layers: TemplateLayer[],
  cache: TemplateCache,
  log: LogFn
) {
  for (const layer of layers) {
    await ensureLayer(layer, cache, log);
  }
}
