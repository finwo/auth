import { app } from '../../../app.js';
import { authenticateAdminSession } from '../../../lib/admin-auth.js';
import { listAdminGlobalUsers } from '../../../lib/admin-users.js';

export default {
  method: 'get',
  path: '/api/v1/admin/users',
  name: 'admin.users.list_global',
  async handler(req) {
    const auth = await authenticateAdminSession(req);
    const users = await listAdminGlobalUsers(auth.systemDb, auth.user);

    return new app.HttpOk({ users }, { 'cache-control': 'no-store' });
  },
};
