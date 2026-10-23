import { app } from '../../../../app.js';
import { authenticateSystemAdmin } from '../../../../lib/admin-auth.js';
import { replaceSystemTemplateLayers } from '../../../../lib/packages.js';

export default {
  method: 'put',
  path: '/api/v1/admin/system/templates',
  name: 'admin.system.templates.replace',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    const body = req.body || {};
    const packageIds = body.package_ids ?? body.layer_ids;
    const layers = await replaceSystemTemplateLayers(auth.systemDb, { packageIds });

    return new app.HttpOk({ layers }, { 'cache-control': 'no-store' });
  },
};
