import { app } from '../../../app.js';
import { authenticateAdminSession } from '../../../lib/admin-auth.js';
import { createAdminRealm } from '../../../lib/admin-realms.js';
import { HttpError } from '../../../lib/http/http-error.js';
import { canCreateRealm } from '../../../lib/policy.js';

export default {
  method: 'post',
  path: '/api/v1/admin/realms',
  name: 'admin.realms.create',
  async handler(req) {
    const auth = await authenticateAdminSession(req);
    if (!canCreateRealm(auth.user)) {
      throw new HttpError(403, 'forbidden', 'Realm creation access is required');
    }

    const realm = await createAdminRealm({
      systemDb: auth.systemDb,
      actor: auth.user,
      body: req.body || {},
    });

    return new app.HttpOk({ ok: true, realm }, { 'cache-control': 'no-store' });
  },
};
