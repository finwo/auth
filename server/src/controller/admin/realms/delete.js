import { app } from '../../../app.js';
import { authenticateAdminSession } from '../../../lib/admin-auth.js';
import { deleteAdminRealm } from '../../../lib/admin-realms.js';
import { HttpError } from '../../../lib/http/http-error.js';
import { findRealmBySlug } from '../../../lib/realm.js';

export default {
  method: 'delete',
  path: '/api/v1/admin/realms/:realm',
  name: 'admin.realms.delete',
  async handler(req) {
    const auth = await authenticateAdminSession(req);
    const realm = await findRealmBySlug(req.params.realm);
    if (!realm) {
      throw new HttpError(404, 'unknown_realm', 'Unknown realm');
    }

    const result = await deleteAdminRealm({
      systemDb: auth.systemDb,
      actor: auth.user,
      realm,
    });

    return new app.HttpOk({ ok: true, removed: result.removed }, { 'cache-control': 'no-store' });
  },
};
