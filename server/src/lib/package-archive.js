import { Readable } from 'node:stream';
import { createGunzip, inflateRawSync } from 'node:zlib';
import { createTarDecoder } from 'modern-tar';
import { HttpError } from './http/http-error.js';

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function detectArchiveFormat(buffer) {
  if (!buffer || buffer.byteLength < 2) return null;
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    if (buffer[2] === 0x03 && buffer[3] === 0x04) return 'zip';
    if (buffer[2] === 0x05 && buffer[3] === 0x06) return 'zip';
    if (buffer[2] === 0x07 && buffer[3] === 0x08) return 'zip';
  }
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return 'gzip';
  if (buffer.length >= 512) return 'tar';
  return null;
}

export function packageExtension(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.tar.gz')) return '.tar.gz';
  if (lower.endsWith('.tgz')) return '.tgz';
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot);
}

export function normalizePackagePath(value, options = {}) {
  const allowAbsolute = options.allowAbsolute !== false;
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new HttpError(400, 'invalid_package', `Invalid package path: ${value}`);
  }

  let input = value.replace(/\\/g, '/');
  if (!allowAbsolute && input.startsWith('/')) {
    throw new HttpError(400, 'invalid_package', `Invalid package path: ${value}`);
  }
  while (input.startsWith('/')) input = input.slice(1);
  if (!input) {
    throw new HttpError(400, 'invalid_package', `Invalid package path: ${value}`);
  }

  const parts = [];
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new HttpError(400, 'invalid_package', `Invalid package path: ${value}`);
    }
    parts.push(part);
  }

  const normalized = parts.join('/');
  if (!normalized || normalized.length > 1024) {
    throw new HttpError(400, 'invalid_package', `Invalid package path: ${value}`);
  }
  return normalized;
}

function invalid(message) {
  return new HttpError(400, 'invalid_package', message);
}

function tooLarge(message) {
  return new HttpError(413, 'package_too_large', message);
}

async function readStreamBody(body, limit) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge('The package contents exceed the size limit');
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return { body: Buffer.concat(chunks, total), size: total };
}

async function readTarEntries(buffer, limits, allowedExtensions, pathOptions) {
  const format = detectArchiveFormat(buffer);
  if (format !== 'gzip' && format !== 'tar') throw invalid('The package archive is invalid');
  if (buffer.byteLength > limits.maxArchiveBytes) {
    throw tooLarge('The package archive exceeds the size limit');
  }

  const source = format === 'gzip'
    ? Readable.from([buffer]).pipe(createGunzip())
    : Readable.from([buffer]);
  const entries = Readable.toWeb(source).pipeThrough(createTarDecoder({ strict: true }));
  const files = new Map();
  const folded = new Set();
  let fileCount = 0;
  let extractedBytes = 0;

  try {
    for await (const entry of entries) {
      const type = entry.header.type || 'file';
      if (type === 'directory') {
        await entry.body.cancel();
        continue;
      }
      if (type !== 'file') {
        await entry.body.cancel();
        throw invalid(`Unsupported package entry type: ${type}`);
      }

      const name = normalizePackagePath(entry.header.name, pathOptions);
      const lower = name.toLowerCase();
      if (folded.has(lower)) throw invalid(`Duplicate package path: ${name}`);
      if (!allowedExtensions.has(packageExtension(name))) {
        throw invalid(`Package file type is not allowed: ${name}`);
      }

      fileCount += 1;
      if (fileCount > limits.maxFiles) throw tooLarge('The package contains too many files');
      const remaining = limits.maxExtractedBytes - extractedBytes;
      if (remaining < 0) throw tooLarge('The package contents exceed the size limit');
      const file = await readStreamBody(entry.body, remaining);
      extractedBytes += file.size;
      folded.add(lower);
      files.set(name, file.body);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalid('The package archive is invalid');
  }

  if (fileCount === 0) throw invalid('The package archive is empty');
  return { format, entries: files, fileCount, extractedBytes };
}

function findEndOfCentralDirectory(buffer) {
  const minimum = 22;
  const maximumComment = 65535;
  const start = Math.max(0, buffer.length - minimum - maximumComment);
  for (let offset = buffer.length - minimum; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD) return offset;
  }
  throw invalid('The package archive is invalid');
}

function readZipEntries(buffer, limits, allowedExtensions, pathOptions) {
  if (buffer.byteLength > limits.maxArchiveBytes) {
    throw tooLarge('The package archive exceeds the size limit');
  }
  if (buffer.length < 22) throw invalid('The package archive is invalid');

  const end = findEndOfCentralDirectory(buffer);
  if (buffer.readUInt16LE(end + 20) !== buffer.length - end - 22) {
    throw invalid('The package archive is invalid');
  }
  if (buffer.readUInt32LE(end) !== ZIP_EOCD) throw invalid('The package archive is invalid');
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) {
    throw invalid('Multi-disk ZIP packages are not supported');
  }

  const totalEntries = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw invalid('ZIP64 packages are not supported');
  }
  if (totalEntries === 0) throw invalid('The package archive is empty');
  if (totalEntries > limits.maxFiles) throw tooLarge('The package contains too many files');
  if (centralOffset + centralSize > end) throw invalid('The package archive is invalid');

  const descriptors = [];
  const folded = new Set();
  let position = centralOffset;
  let declaredBytes = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (position + 46 > end || buffer.readUInt32LE(position) !== ZIP_CENTRAL) {
      throw invalid('The package archive is invalid');
    }

    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const crc = buffer.readUInt32LE(position + 16);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const uncompressedSize = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const nameStart = position + 46;
    const next = nameStart + nameLength + extraLength + commentLength;

    if (next > end) throw invalid('The package archive is invalid');
    if (flags & 0x0001 || flags & 0x2000) throw invalid('Encrypted ZIP packages are not supported');
    if (method !== 0 && method !== 8) throw invalid(`Unsupported ZIP compression method: ${method}`);
    if (uncompressedSize > limits.maxExtractedBytes || compressedSize > limits.maxArchiveBytes) {
      throw tooLarge('The package contents exceed the size limit');
    }

    declaredBytes += uncompressedSize;
    if (declaredBytes > limits.maxExtractedBytes) {
      throw tooLarge('The package contents exceed the size limit');
    }

    const rawName = Buffer.from(buffer.subarray(nameStart, nameStart + nameLength));
    const rawText = rawName.toString('utf8');
    if (rawText.endsWith('/')) {
      position = next;
      continue;
    }
    const name = normalizePackagePath(rawText, pathOptions);
    const lower = name.toLowerCase();
    if (folded.has(lower)) throw invalid(`Duplicate package path: ${name}`);
    if (!allowedExtensions.has(packageExtension(name))) {
      throw invalid(`Package file type is not allowed: ${name}`);
    }
    folded.add(lower);
    descriptors.push({ name, rawName, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    position = next;
  }

  if (position !== centralOffset + centralSize) throw invalid('The package archive is invalid');

  const entries = new Map();
  let extractedBytes = 0;
  for (const descriptor of descriptors) {
    const local = descriptor.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== ZIP_LOCAL) {
      throw invalid('The package archive is invalid');
    }
    const localNameLength = buffer.readUInt16LE(local + 26);
    const localExtraLength = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + descriptor.compressedSize;
    if (dataEnd > buffer.length) throw invalid('The package archive is invalid');
    if (
      localNameLength !== descriptor.rawName.length ||
      !descriptor.rawName.equals(buffer.subarray(local + 30, local + 30 + localNameLength))
    ) {
      throw invalid('The package archive is invalid');
    }

    let body;
    const remaining = limits.maxExtractedBytes - extractedBytes;
    if (remaining < 0) throw tooLarge('The package contents exceed the size limit');
    if (descriptor.method === 0) {
      if (descriptor.compressedSize !== descriptor.uncompressedSize) {
        throw invalid('The package archive is invalid');
      }
      if (descriptor.uncompressedSize > remaining) {
        throw tooLarge('The package contents exceed the size limit');
      }
      body = Buffer.from(buffer.subarray(dataStart, dataEnd));
    } else {
      try {
        body = inflateRawSync(buffer.subarray(dataStart, dataEnd), { maxOutputLength: remaining });
      } catch {
        throw tooLarge('The package contents exceed the size limit');
      }
    }

    if (body.length !== descriptor.uncompressedSize || crc32(body) !== descriptor.crc) {
      throw invalid('The package archive is invalid');
    }
    extractedBytes += body.length;
    entries.set(descriptor.name, body);
  }

  return { format: 'zip', entries, fileCount: descriptors.length, extractedBytes };
}

export async function readArchiveEntries(buffer, options = {}) {
  const limits = {
    maxArchiveBytes: options.maxArchiveBytes ?? 2 * 1024 * 1024,
    maxExtractedBytes: options.maxExtractedBytes ?? 10 * 1024 * 1024,
    maxFiles: options.maxFiles ?? 256,
  };
  const allowedExtensions = options.allowedExtensions;
  if (!(allowedExtensions instanceof Set)) {
    throw new Error('allowedExtensions is required');
  }

  const pathOptions = { allowAbsolute: options.allowAbsolute !== false };
  const format = detectArchiveFormat(buffer);
  if (format === 'zip') return readZipEntries(buffer, limits, allowedExtensions, pathOptions);
  if (format === 'gzip' || format === 'tar') {
    return readTarEntries(buffer, limits, allowedExtensions, pathOptions);
  }
  throw invalid('The package archive is invalid');
}
