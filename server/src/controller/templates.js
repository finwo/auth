import fs from 'node:fs';
import { app } from '../app.js';
import { resolveHostContext } from '../lib/host-context.js';
import { HttpError } from '../lib/http/http-error.js';
import { getSystemDatabase } from '../lib/realm.js';
import {
  builtinTemplateArchivePath,
  builtinTemplateManifest,
  effectiveTemplateManifest,
  templateArchivePath,
} from '../lib/templates.js';

const cache = new Map();

function readBuiltin(file) {
  if (!cache.has(file)) {
    cache.set(file, fs.readFileSync(file));
  }
  return cache.get(file);
}

function send(res, req, status, headers, body) {
  res.writeHead(status, {
    'x-content-type-options': 'nosniff',
    'content-length': body.byteLength,
    ...headers,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

function missing(res, req) {
  send(
    res,
    req,
    503,
    { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' },
    Buffer.from('template build missing')
  );
}

function notFound(res, req) {
  send(
    res,
    req,
    404,
    { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    Buffer.from('Not found')
  );
}

async function manifest(req, res) {
  let context;
  try {
    context = await resolveHostContext(req, {
      publicUrl: app.config.server.public_url,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      error.toResponse().send(res);
      return;
    }
    console.error(error);
    send(
      res,
      req,
      500,
      { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      Buffer.from(JSON.stringify({ error: { code: 'internal_error', message: 'Internal server error' } }))
    );
    return;
  }

  let base;
  try {
    base = builtinTemplateManifest();
  } catch {
    missing(res, req);
    return;
  }

  let value;
  try {
    value = await effectiveTemplateManifest(getSystemDatabase(), context, base);
  } catch (error) {
    if (error instanceof HttpError) {
      error.toResponse().send(res);
      return;
    }
    console.error(error);
    send(
      res,
      req,
      500,
      { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      Buffer.from(JSON.stringify({ error: { code: 'internal_error', message: 'Internal server error' } }))
    );
    return;
  }

  send(
    res,
    req,
    200,
    { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' },
    Buffer.from(JSON.stringify(value))
  );
}

function archive(res, req, digest) {
  let body;
  try {
    body = fs.readFileSync(templateArchivePath(digest));
  } catch {
    try {
      body = readBuiltin(builtinTemplateArchivePath(digest));
    } catch {
      notFound(res, req);
      return;
    }
  }

  send(
    res,
    req,
    200,
    {
      'content-type': 'application/gzip',
      'cache-control': 'public, max-age=31536000, immutable',
    },
    body
  );
}

export default {
  mount: '/app/templates',
  name: 'templates',
  async handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(
        res,
        req,
        405,
        { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' },
        Buffer.from('Method not allowed')
      );
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');
    let name;
    try {
      name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      notFound(res, req);
      return;
    }
    if (name.startsWith('app/templates/')) {
      name = name.slice('app/templates/'.length);
    }

    if (name === 'manifest.json') {
      await manifest(req, res);
      return;
    }

    const match = /^([a-f0-9]{64})\.tar\.gz$/.exec(name);
    if (match) {
      archive(res, req, match[1]);
      return;
    }

    notFound(res, req);
  },
};
