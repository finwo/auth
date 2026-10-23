import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const templatesRoot = path.join(repoRoot, 'app', 'login', 'dist', 'templates');
const cache = new Map();

function read(file) {
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

export default {
  mount: '/app/templates',
  name: 'templates',
  handler(req, res) {
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
    let name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (name.startsWith('app/templates/')) {
      name = name.slice('app/templates/'.length);
    }

    if (name === 'manifest.json') {
      try {
        const body = read(path.join(templatesRoot, 'manifest.json'));
        send(
          res,
          req,
          200,
          { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' },
          body
        );
      } catch {
        missing(res, req);
      }
      return;
    }

    if (/^[a-f0-9]{64}\.tar\.gz$/.test(name)) {
      try {
        const body = read(path.join(templatesRoot, name));
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
      } catch {
        missing(res, req);
      }
      return;
    }

    send(
      res,
      req,
      404,
      { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      Buffer.from('Not found')
    );
  },
};
