import fs from 'node:fs';
import { app } from '../app.js';
import { resolveHostContext } from '../lib/host-context.js';
import { HttpError } from '../lib/http/http-error.js';
import { resolvePackageArtifactFile } from '../lib/packages.js';
import { getSystemDatabase } from '../lib/realm.js';

function send(res, req, body) {
  res.writeHead(200, {
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

export default {
  mount: '/api/v1/packages',
  name: 'packages.artifacts',
  async handler(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      }
      await resolveHostContext(req, { publicUrl: app.config.server.public_url });

      const pathname = new URL(req.url || '/', 'http://localhost').pathname;
      const match =
        /^(?:\/api\/v1\/packages)?\/([0-9a-f-]{36})\/([^/]+)$/i.exec(pathname);
      if (!match) throw new HttpError(404, 'not_found', 'Not found');

      const file = await resolvePackageArtifactFile(
        getSystemDatabase(),
        match[1],
        decodeURIComponent(match[2])
      );
      if (!file) throw new HttpError(404, 'not_found', 'Not found');

      send(res, req, fs.readFileSync(file));
    } catch (error) {
      if (error instanceof HttpError) {
        error.toResponse().send(res);
        return;
      }
      console.error(error);
      new HttpError(500, 'internal_error', 'Internal server error').toResponse().send(res);
    }
  },
};
