import { app } from '../../../app.js';
import { authenticateSystemAdmin } from '../../../lib/admin-auth.js';
import { deletePackage } from '../../../lib/packages.js';

export default {
  method: 'delete',
  path: '/api/v1/admin/packages/:id',
  name: 'admin.packages.delete',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    await deletePackage(auth.systemDb, req.params.id);

    return new app.HttpOk({ ok: true }, { 'cache-control': 'no-store' });
  },
};
