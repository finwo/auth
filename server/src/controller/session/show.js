import { app } from '../../app.js';
import { resolveHostContext } from '../../lib/host-context.js';
import { HttpError } from '../../lib/http/http-error.js';
import { getSystemDatabase, openRealmDatabase, realmMetadata } from '../../lib/realm.js';
import { isSystemAdmin } from '../../lib/policy.js';
import { authenticateRequest } from '../../lib/session.js';

export default {
  method: 'get',
  path: '/api/v1/session',
  name: 'session.show',
  async handler(req, res) {
    const hostContext = await resolveHostContext(req, {
      publicUrl: app.config.server.public_url,
    });
    const realmDb = hostContext.realm ? await openRealmDatabase(hostContext.realm) : null;
    const metadata = hostContext.realm ? await realmMetadata(hostContext.realm) : null;
    const auth = await authenticateRequest({
      systemDb: getSystemDatabase(),
      realmDb,
      req,
      res,
      context: hostContext,
    });

    if (!auth) {
      throw new HttpError(401, 'not_authenticated', 'Not signed in');
    }
    if (
      hostContext.mode !== 'canonical' &&
      !isSystemAdmin(auth.user) &&
      (!auth.membership || auth.membership.status !== 'active')
    ) {
      throw new HttpError(401, 'not_authenticated', 'Not signed in');
    }

    return new app.HttpOk({
      scope: {
        type: auth.session.scope_type,
        host: auth.session.scope_host,
        realm_id: auth.session.realm_id,
        client_id: auth.session.client_id,
      },
      realm: metadata,
      user: {
        id: auth.user.id,
        username: auth.user.username,
        display_name: auth.user.display_name,
      },
      roles: auth.roles,
      is_system_admin: isSystemAdmin(auth.user),
      expires_at: auth.session.expires_at,
    });
  },
};
