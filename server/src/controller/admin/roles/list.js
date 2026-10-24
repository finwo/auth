import { app } from '../../../app.js';
import { authenticateAdminRequest } from '../../../lib/admin-auth.js';
import { listAdminRealmRoles } from '../../../lib/admin-clients.js';

export default {
  method: 'get',
  path: '/api/v1/admin/realms/:realm/roles',
  name: 'admin.roles.list',
  async handler(req) {
    const auth = await authenticateAdminRequest(req, {
      realmSlug: req.params.realm,
    });
    const roles = await listAdminRealmRoles(auth.realmDb);

    return new app.HttpOk({ roles }, { 'cache-control': 'no-store' });
  },
};
