import fs from 'node:fs';
import { buildAppConfig } from './app-config.js';
import {
  builtinTemplateArchivePath,
  builtinTemplateManifest,
  findTemplateFileByDigest,
} from './packages.js';
import { getSystemDatabase } from './realm.js';

function sendJson(res, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendGzip(res, req, body) {
  res.writeHead(200, {
    'x-content-type-options': 'nosniff',
    'content-type': 'application/gzip',
    'content-length': body.byteLength,
    'cache-control': 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

export async function serveAppConfig(req, res, options) {
  const value = await buildAppConfig(req, options);
  sendJson(res, value);
}

export async function serveTemplateAsset(req, res, digest) {
  let file = null;
  try {
    const base = builtinTemplateManifest();
    if (base.base?.digest === digest) file = builtinTemplateArchivePath(digest);
  } catch {}
  if (!file) file = await findTemplateFileByDigest(getSystemDatabase(), digest);
  if (!file) return false;
  sendGzip(res, req, fs.readFileSync(file));
  return true;
}
