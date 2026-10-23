import { app } from '../../../app.js';
import { authenticateSystemAdmin } from '../../../lib/admin-auth.js';
import { listTemplatePackages } from '../../../lib/packages.js';

export default {
  method: 'get',
  path: '/api/v1/admin/templates',
  name: 'admin.templates.list',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    const templates = await listTemplatePackages(auth.systemDb);

    return new app.HttpOk(
      { templates },
      { 'cache-control': 'no-store' }
    );
  },
};
