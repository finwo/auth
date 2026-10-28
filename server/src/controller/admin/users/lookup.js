import { app } from '../../../app.js';
import { authenticateAdminRequest } from '../../../lib/admin-auth.js';
import { lookupAdminRealmUser } from '../../../lib/admin-users.js';

export default {
  method: 'get',
  path: '/api/v1/admin/realms/:realm/user-lookup',
  name: 'admin.users.lookup',
  async handler(req) {
    const auth = await authenticateAdminRequest(req, {
      realmSlug: req.params.realm,
    });
    const url = new URL(req.url, 'http://localhost');
    const user = await lookupAdminRealmUser({
      systemDb: auth.systemDb,
      realmDb: auth.realmDb,
      realmId: auth.realm.id,
      identifier: url.searchParams.get('identifier'),
    });

    return new app.HttpOk(
      { ok: true, user },
      { 'cache-control': 'no-store' }
    );
  },
};
