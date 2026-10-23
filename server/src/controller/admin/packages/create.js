import { app } from '../../../app.js';
import { authenticateSystemAdmin } from '../../../lib/admin-auth.js';
import { HttpError } from '../../../lib/http/http-error.js';
import {
  readMultipart,
  readRequestBuffer,
  requestMediaType,
} from '../../../lib/http/upload.js';
import { uploadPackage } from '../../../lib/packages.js';

export default {
  method: 'post',
  path: '/api/v1/admin/packages',
  name: 'admin.packages.create',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    const maxBytes = app.config.packages.max_archive_bytes;
    const type = requestMediaType(req);

    let buffer;
    let filename = null;
    if (type === 'multipart/form-data') {
      const upload = await readMultipart(req, maxBytes + 65536);
      buffer = upload.file.buffer;
      filename = upload.file.filename;
    } else if (
      type === 'application/gzip' ||
      type === 'application/x-gzip' ||
      type === 'application/zip' ||
      type === 'application/x-tar'
    ) {
      buffer = await readRequestBuffer(req, maxBytes);
    } else {
      throw new HttpError(
        415,
        'unsupported_media_type',
        'Packages must use multipart/form-data, application/gzip, application/zip or application/x-tar'
      );
    }

    const uploaded = await uploadPackage(auth.systemDb, {
      buffer,
      userId: auth.user.id,
      filename,
    });

    return new app.HttpResponse(
      201,
      { package: uploaded },
      { 'cache-control': 'no-store' }
    );
  },
};
