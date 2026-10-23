import { app } from '../../../app.js';
import { authenticateSystemAdmin } from '../../../lib/admin-auth.js';
import { deleteTemplateLayer } from '../../../lib/templates.js';

export default {
  method: 'delete',
  path: '/api/v1/admin/templates/:id',
  name: 'admin.templates.delete',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    await deleteTemplateLayer(auth.systemDb, req.params.id);

    return new app.HttpOk({ ok: true }, { 'cache-control': 'no-store' });
  },
};
