import { app } from '../../../app.js';
import { authenticateAdminRequest } from '../../../lib/admin-auth.js';
import { findAdminRealmSession } from '../../../lib/admin-sessions.js';
import { HttpError } from '../../../lib/http/http-error.js';
import { revokeSessionRealm } from '../../../lib/session.js';

export default {
  method: 'delete',
  path: '/api/v1/admin/realms/:realm/sessions/:publicId/realm',
  name: 'admin.sessions.revoke-realm',
  async handler(req) {
    const auth = await authenticateAdminRequest(req, {
      realmSlug: req.params.realm,
    });
    const session = await findAdminRealmSession(auth.systemDb, {
      realmId: auth.realm.id,
      publicId: req.params.publicId,
    });
    if (!session) {
      throw new HttpError(404, 'session_not_found', 'Session not found');
    }

    const binding = await revokeSessionRealm(auth.systemDb, {
      sessionId: session.id,
      realmId: auth.realm.id,
      revokedBy: auth.user.id,
    });

    return new app.HttpOk({
      ok: true,
      revoked_at: binding.revoked_at,
    });
  },
};
