import { app } from '../../../app.js';
import { authenticateAdminRequest } from '../../../lib/admin-auth.js';
import {
  canTerminateSession,
  findAdminRealmSession,
} from '../../../lib/admin-sessions.js';
import { HttpError } from '../../../lib/http/http-error.js';
import { destroySessionById } from '../../../lib/session.js';

export default {
  method: 'delete',
  path: '/api/v1/admin/realms/:realm/sessions/:publicId',
  name: 'admin.sessions.terminate',
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
    if (!canTerminateSession(auth.user, session, auth.realm.id)) {
      throw new HttpError(
        403,
        'forbidden',
        'Only home-realm and system admins can terminate this session'
      );
    }

    await destroySessionById(auth.systemDb, session.id);
    return new app.HttpOk({ ok: true });
  },
};
