import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../app.js';
import { canonicalBaseUrl } from './oidc/context.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const appNames = ['login', 'account', 'admin'];
const cache = new Map();

function appDist(name) {
  if (!appNames.includes(name)) throw new Error(`unknown app: ${name}`);
  return path.join(repoRoot, 'app', name, 'dist');
}

export function appIndex(name) {
  if (!cache.has(name)) {
    const file = path.join(appDist(name), 'index.html');
    try {
      cache.set(name, fs.readFileSync(file));
    } catch {
      cache.set(name, null);
    }
  }
  return cache.get(name);
}

export function serveAppDocument(res, name) {
  const content = appIndex(name);
  if (!content) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${name} app build missing`);
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(content);
}

function addOriginUrl(urls, base, pathname) {
  if (!base) return;
  urls.add(`${String(base).replace(/\/+$/, '')}${pathname}`);
}

export function systemClientRedirectUris(context, clientId) {
  const urls = new Set();
  const publicBase = canonicalBaseUrl(app.config.server.public_url);

  if (clientId === 'admin') {
    addOriginUrl(urls, publicBase, '/app/admin/callback');
  } else if (clientId === 'account') {
    addOriginUrl(urls, publicBase, '/app/account/callback');
    if (context.mode === 'realm') {
      addOriginUrl(urls, context.origin, '/app/account/callback');
    }
  }

  const staticOrigin = app.config.apps?.[clientId];
  addOriginUrl(urls, staticOrigin, '/callback');
  return [...urls];
}

export function systemClientPostLogoutUris(context, clientId) {
  const urls = new Set();
  const publicBase = canonicalBaseUrl(app.config.server.public_url);

  if (clientId === 'admin') {
    addOriginUrl(urls, publicBase, '/app/admin/');
  } else if (clientId === 'account') {
    addOriginUrl(urls, publicBase, '/app/account/');
    if (context.mode === 'realm') {
      addOriginUrl(urls, context.origin, '/app/account/');
    }
  }

  const staticOrigin = app.config.apps?.[clientId];
  addOriginUrl(urls, staticOrigin, '/');
  return [...urls];
}
