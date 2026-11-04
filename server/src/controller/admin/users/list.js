import { app } from '../../../app.js';
import { authenticateAdminRequest } from '../../../lib/admin-auth.js';
import { listAdminRealmUsers } from '../../../lib/admin-users.js';

export default {
  method: 'get',
  path: '/api/v1/admin/realms/:realm/users',
  name: 'admin.users.list',
  async handler(req) {
    const auth = await authenticateAdminRequest(req, {
      realmSlug: req.params.realm,
    });
    const users = await listAdminRealmUsers(
      auth.systemDb,
      auth.realmDb,
      auth.realm
    );

    return new app.HttpOk({ users }, { 'cache-control': 'no-store' });
  },
};
