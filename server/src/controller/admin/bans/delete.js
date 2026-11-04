import { app } from '../../../app.js';
import { authenticateAdminRequest } from '../../../lib/admin-auth.js';
import { assertAdminRealmUser } from '../../../lib/admin-users.js';
import { deleteBan } from '../../../lib/bans.js';
import { HttpError } from '../../../lib/http/http-error.js';

export default {
  method: 'delete',
  path: '/api/v1/admin/realms/:realm/users/:userId/bans/:clientId',
  name: 'admin.bans.delete',
  async handler(req) {
    const auth = await authenticateAdminRequest(req, {
      realmSlug: req.params.realm,
    });
    const user = await assertAdminRealmUser({
      systemDb: auth.systemDb,
      realmDb: auth.realmDb,
      realm: auth.realm,
      userId: req.params.userId,
    });

    const removed = await deleteBan(auth.realmDb, {
      userId: user.id,
      clientId: req.params.clientId,
    });
    if (!removed) {
      throw new HttpError(404, 'ban_not_found', 'Ban not found');
    }

    return new app.HttpOk(
      { ok: true, removed: true },
      { 'cache-control': 'no-store' }
    );
  },
};
