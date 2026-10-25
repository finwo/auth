import { app } from '../../../app.js';
import { authenticateAdminSession } from '../../../lib/admin-auth.js';
import { getAdminGlobalUserOverview } from '../../../lib/admin-users.js';
import { HttpError } from '../../../lib/http/http-error.js';

export default {
  method: 'get',
  path: '/api/v1/admin/users/:userId',
  name: 'admin.users.get_global',
  async handler(req) {
    const auth = await authenticateAdminSession(req);
    const user = await getAdminGlobalUserOverview(
      auth.systemDb,
      auth.user,
      req.params.userId
    );
    if (!user) {
      throw new HttpError(404, 'user_not_found', 'User not found');
    }

    return new app.HttpOk(user, { 'cache-control': 'no-store' });
  },
};
