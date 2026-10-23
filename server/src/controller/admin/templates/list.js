import { app } from '../../../app.js';
import { authenticateSystemAdmin } from '../../../lib/admin-auth.js';
import { listTemplateLayers, serializeTemplateLayer } from '../../../lib/templates.js';

export default {
  method: 'get',
  path: '/api/v1/admin/templates',
  name: 'admin.templates.list',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    const templates = await listTemplateLayers(auth.systemDb);

    return new app.HttpOk(
      { templates: templates.map(serializeTemplateLayer) },
      { 'cache-control': 'no-store' }
    );
  },
};
