import { app } from '../../../app.js';
import { authenticateSystemAdmin } from '../../../lib/admin-auth.js';
import { HttpError } from '../../../lib/http/http-error.js';
import { addTemplateLayer, serializeTemplateLayer } from '../../../lib/templates.js';

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'template_too_large', 'The template archive exceeds the size limit');
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > limit) {
      throw new HttpError(413, 'template_too_large', 'The template archive exceeds the size limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function archiveType(req) {
  const value = String(req.headers['content-type'] || '');
  return value.split(';')[0].trim().toLowerCase();
}

export default {
  method: 'post',
  path: '/api/v1/admin/templates',
  name: 'admin.templates.create',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    const type = archiveType(req);
    if (type !== 'application/gzip' && type !== 'application/x-gzip') {
      throw new HttpError(
        415,
        'unsupported_media_type',
        'The template archive must use application/gzip'
      );
    }

    const url = new URL(req.url || '/', 'http://localhost');
    const buffer = await readBody(req, app.config.templates.max_archive_bytes);
    const template = await addTemplateLayer(auth.systemDb, {
      buffer,
      label: url.searchParams.get('label'),
      userId: auth.user.id,
    });

    return new app.HttpResponse(
      201,
      { template: serializeTemplateLayer(template) },
      { 'cache-control': 'no-store' }
    );
  },
};
