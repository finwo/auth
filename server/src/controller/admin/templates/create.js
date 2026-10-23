import { app } from '../../../app.js';
import { authenticateSystemAdmin } from '../../../lib/admin-auth.js';
import { HttpError } from '../../../lib/http/http-error.js';
import {
  readMultipart,
  readRequestBuffer,
  requestMediaType,
} from '../../../lib/http/upload.js';
import {
  isDistributionPackage,
  uploadTemplateArtifact,
  uploadTemplatePackage,
} from '../../../lib/packages.js';

export default {
  method: 'post',
  path: '/api/v1/admin/templates',
  name: 'admin.templates.create',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    const maxBytes = app.config.packages.max_archive_bytes;
    const type = requestMediaType(req);

    let template;
    if (type === 'multipart/form-data') {
      const upload = await readMultipart(req, maxBytes + 65536);
      const distribution = await isDistributionPackage(upload.file.buffer);
      template = distribution
        ? await uploadTemplatePackage(auth.systemDb, {
            buffer: upload.file.buffer,
            userId: auth.user.id,
            filename: upload.file.filename,
          })
        : await uploadTemplateArtifact(auth.systemDb, {
            buffer: upload.file.buffer,
            values: upload.fields,
            userId: auth.user.id,
            filename: upload.file.filename,
          });
    } else if (
      type === 'application/gzip' ||
      type === 'application/x-gzip' ||
      type === 'application/zip' ||
      type === 'application/x-tar'
    ) {
      const buffer = await readRequestBuffer(req, maxBytes);
      template = await uploadTemplatePackage(auth.systemDb, {
        buffer,
        userId: auth.user.id,
      });
    } else {
      throw new HttpError(
        415,
        'unsupported_media_type',
        'Template uploads must use multipart/form-data, application/gzip, application/zip or application/x-tar'
      );
    }

    return new app.HttpResponse(
      201,
      { template },
      { 'cache-control': 'no-store' }
    );
  },
};
