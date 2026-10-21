import { app } from '../../../app.js';
import { authenticateAdminRequest } from '../../../lib/admin-auth.js';
import { listAdminRealmSessions } from '../../../lib/admin-sessions.js';

export default {
  method: 'get',
  path: '/api/v1/admin/realms/:realm/sessions',
  name: 'admin.sessions.list',
  async handler(req) {
    const auth = await authenticateAdminRequest(req, {
      realmSlug: req.params.realm,
    });
    const sessions = await listAdminRealmSessions(auth.systemDb, {
      realmId: auth.realm.id,
      actor: auth.user,
    });

    return new app.HttpOk({ sessions }, { 'cache-control': 'no-store' });
  },
};
