import { app } from '../../../app.js';
import { authenticateAdminSession } from '../../../lib/admin-auth.js';
import { listAdminRealmOptions } from '../../../lib/system-clients.js';

export default {
  method: 'get',
  path: '/api/v1/admin/realms',
  name: 'admin.realms.list',
  async handler(req) {
    const auth = await authenticateAdminSession(req);
    const realms = await listAdminRealmOptions(auth.systemDb, auth.user);

    return new app.HttpOk({ realms }, { 'cache-control': 'no-store' });
  },
};
