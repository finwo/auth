import { app } from '../../../app.js';
import { authenticateAdminSession } from '../../../lib/admin-auth.js';
import { getAdminCurrentUser } from '../../../lib/admin-users.js';

export default {
  method: 'get',
  path: '/api/v1/admin/me',
  name: 'admin.me',
  async handler(req) {
    const auth = await authenticateAdminSession(req);
    const user = await getAdminCurrentUser(auth.systemDb, auth.user);

    return new app.HttpOk({ user }, { 'cache-control': 'no-store' });
  },
};
