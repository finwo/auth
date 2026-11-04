import { app } from '../../../app.js';
import { authenticateAdminRequest } from '../../../lib/admin-auth.js';
import { getAdminRealmUserDetail } from '../../../lib/admin-users.js';
import { HttpError } from '../../../lib/http/http-error.js';

export default {
  method: 'get',
  path: '/api/v1/admin/realms/:realm/users/:userId',
  name: 'admin.users.get',
  async handler(req) {
    const auth = await authenticateAdminRequest(req, {
      realmSlug: req.params.realm,
    });
    const detail = await getAdminRealmUserDetail({
      systemDb: auth.systemDb,
      realmDb: auth.realmDb,
      realm: auth.realm,
      userId: req.params.userId,
      actor: auth.user,
      actorRoles: auth.roles,
    });
    if (!detail) {
      throw new HttpError(404, 'user_not_found', 'User not found');
    }

    return new app.HttpOk(detail, { 'cache-control': 'no-store' });
  },
};
