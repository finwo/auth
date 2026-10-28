import { app } from '../../../app.js';
import { authenticateAdminRequest } from '../../../lib/admin-auth.js';
import { updateAdminRealmRoles } from '../../../lib/admin-users.js';

export default {
  method: 'put',
  path: '/api/v1/admin/realms/:realm/users/:userId/roles',
  name: 'admin.users.roles',
  async handler(req) {
    const auth = await authenticateAdminRequest(req, {
      realmSlug: req.params.realm,
    });
    const detail = await updateAdminRealmRoles({
      systemDb: auth.systemDb,
      realmDb: auth.realmDb,
      realmId: auth.realm.id,
      userId: req.params.userId,
      body: req.body || {},
      actor: auth.user,
      actorRoles: auth.roles,
    });

    return new app.HttpOk({ ok: true, ...detail }, { 'cache-control': 'no-store' });
  },
};
