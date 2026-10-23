import { app } from '../../../app.js';
import { authenticateSystemAdmin } from '../../../lib/admin-auth.js';
import { deleteTemplatePackage } from '../../../lib/packages.js';

export default {
  method: 'delete',
  path: '/api/v1/admin/templates/:id',
  name: 'admin.templates.delete',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    await deleteTemplatePackage(auth.systemDb, req.params.id);

    return new app.HttpOk({ ok: true }, { 'cache-control': 'no-store' });
  },
};
