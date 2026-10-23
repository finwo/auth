import { app } from '../../../../app.js';
import { authenticateSystemAdmin } from '../../../../lib/admin-auth.js';
import { listSystemTemplateLayers } from '../../../../lib/packages.js';

export default {
  method: 'get',
  path: '/api/v1/admin/system/templates',
  name: 'admin.system.templates.list',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    const layers = await listSystemTemplateLayers(auth.systemDb);

    return new app.HttpOk({ layers }, { 'cache-control': 'no-store' });
  },
};
