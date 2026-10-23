import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { createGunzip } from 'node:zlib';
import { createTarDecoder } from 'modern-tar';
import { HttpError } from './http/http-error.js';
import { detectArchiveFormat } from './package-archive.js';

export const PACKAGE_LIMITS = Object.freeze({
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

function invalid(message) {
  return new HttpError(400, 'invalid_template', message);
}

function tooLarge(message) {
  return new HttpError(413, 'template_too_large', message);
}

function normalizeRuntimePath(value) {
  const input = String(value || '').replace(/\\/g, '/');
  if (!input || input.includes('\0') || input.startsWith('/')) {
    throw invalid(`Invalid template path: ${value}`);
  }

  const parts = [];
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw invalid(`Invalid template path: ${value}`);
    }
    parts.push(part);
  }

  if (parts.length === 0) {
    throw invalid(`Invalid template path: ${value}`);
  }
  return parts.join('/');
}

function extensionOf(value) {
  const name = value.slice(value.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

async function consumedBytes(body, limit) {
  const reader = body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge('The template contents exceed the size limit');
    }
  }
}

export async function validateTemplateArchive(buffer, options = {}) {
  const limits = {
    maxArchiveBytes: options.maxArchiveBytes ?? PACKAGE_LIMITS.maxArchiveBytes,
    maxExtractedBytes: options.maxExtractedBytes ?? PACKAGE_LIMITS.maxExtractedBytes,
    maxFiles: options.maxFiles ?? PACKAGE_LIMITS.maxFiles,
  };

  if (!buffer || buffer.byteLength > limits.maxArchiveBytes) {
    throw tooLarge('The template archive exceeds the size limit');
  }

  const format = detectArchiveFormat(buffer);
  if (format !== 'gzip' && format !== 'tar') {
    throw invalid('The template archive is invalid');
  }

  try {
    const source = format === 'gzip'
      ? Readable.from([buffer]).pipe(createGunzip())
      : Readable.from([buffer]);
    const entries = Readable.toWeb(source).pipeThrough(createTarDecoder({ strict: true }));

    let fileCount = 0;
    let extractedBytes = 0;
    const seen = new Set();

    for await (const entry of entries) {
      const type = entry.header.type || 'file';
      if (type === 'directory') {
        await entry.body.cancel();
        continue;
      }
      if (type !== 'file') {
        await entry.body.cancel();
        throw invalid(`Unsupported tar entry type: ${type}`);
      }

      const name = normalizeRuntimePath(entry.header.name);
      const lower = name.toLowerCase();
      if (name === 'manifest.json') {
        throw invalid('Template archives must not contain manifest.json');
      }
      if (seen.has(lower)) {
        throw invalid(`Duplicate template path: ${name}`);
      }
      if (!allowedExtensions.has(extensionOf(name))) {
        throw invalid(`Template file type is not allowed: ${name}`);
      }

      seen.add(lower);
      fileCount += 1;
      if (fileCount > limits.maxFiles) {
        throw tooLarge('The template contains too many files');
      }

      extractedBytes += await consumedBytes(entry.body, limits.maxExtractedBytes - extractedBytes);
    }

    if (fileCount === 0) throw invalid('The template archive is empty');
    return { fileCount, extractedBytes };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalid('The template archive is invalid');
  }
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function normalizeTemplateArtifact(buffer, options = {}) {
  const format = detectArchiveFormat(buffer);
  if (format !== 'gzip' && format !== 'tar') {
    throw invalid('The template archive is invalid');
  }

  const details = await validateTemplateArchive(buffer, options);
  const normalized = format === 'gzip' ? Buffer.from(buffer) : gzipSync(buffer, { level: 9 });
  return {
    buffer: normalized,
    digest: sha256Hex(normalized),
    fileCount: details.fileCount,
  };
}
