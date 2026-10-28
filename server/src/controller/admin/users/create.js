import { app } from '../../../app.js';
import { authenticateAdminRequest } from '../../../lib/admin-auth.js';
import { addAdminRealmMember } from '../../../lib/admin-users.js';
import { HttpError } from '../../../lib/http/http-error.js';

function assertBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object');
  }
  for (const field of Object.keys(body)) {
    if (field !== 'user_id') {
      throw new HttpError(400, 'invalid_request', `Unknown field: ${field}`);
    }
  }
}

export default {
  method: 'post',
  path: '/api/v1/admin/realms/:realm/users',
  name: 'admin.users.create',
  async handler(req) {
    const auth = await authenticateAdminRequest(req, {
      realmSlug: req.params.realm,
    });
    const body = req.body || {};
    assertBody(body);
    const detail = await addAdminRealmMember({
      systemDb: auth.systemDb,
      realmDb: auth.realmDb,
      realmId: auth.realm.id,
      userId: body.user_id,
      actor: auth.user,
      actorRoles: auth.roles,
    });

    return new app.HttpOk({ ok: true, ...detail }, { 'cache-control': 'no-store' });
  },
};
