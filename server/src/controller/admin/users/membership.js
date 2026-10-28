import { app } from '../../../app.js';
import { authenticateAdminRequest } from '../../../lib/admin-auth.js';
import { updateAdminRealmMembership } from '../../../lib/admin-users.js';

export default {
  method: 'patch',
  path: '/api/v1/admin/realms/:realm/users/:userId/membership',
  name: 'admin.users.membership',
  async handler(req) {
    const auth = await authenticateAdminRequest(req, {
      realmSlug: req.params.realm,
    });
    const result = await updateAdminRealmMembership({
      systemDb: auth.systemDb,
      realmDb: auth.realmDb,
      realmId: auth.realm.id,
      userId: req.params.userId,
      body: req.body || {},
      actor: auth.user,
      actorRoles: auth.roles,
    });

    return new app.HttpOk({ ok: true, ...result }, { 'cache-control': 'no-store' });
  },
};
