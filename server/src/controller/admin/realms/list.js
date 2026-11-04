import { app } from '../../../app.js';
import { authenticateAdminSession } from '../../../lib/admin-auth.js';
import { listAdminRealmsDetail } from '../../../lib/admin-realms.js';

export default {
  method: 'get',
  path: '/api/v1/admin/realms',
  name: 'admin.realms.list',
  async handler(req) {
    const auth = await authenticateAdminSession(req);
    const realms = await listAdminRealmsDetail(auth.systemDb, auth.user);

    return new app.HttpOk({ realms }, { 'cache-control': 'no-store' });
  },
};
