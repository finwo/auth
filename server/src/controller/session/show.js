import { app } from '../../app.js';
import { HttpError } from '../../lib/http/http-error.js';
import { getSystemDatabase, openRealmDatabase, realmMetadata, resolveRealm } from '../../lib/realm.js';
import { authenticateRequest } from '../../lib/session.js';

export default {
  method: 'get',
  path: '/api/v1/session',
  name: 'session.show',
  async handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const realm = await resolveRealm({
      host: req.headers.host,
      slug: url.searchParams.get('realm') || undefined,
    });
    const metadata = await realmMetadata(realm);
    const realmDb = await openRealmDatabase(realm);
    const auth = await authenticateRequest({
      systemDb: getSystemDatabase(),
      realmDb,
      req,
      res,
      realm,
    });

    if (!auth) {
      throw new HttpError(401, 'not_authenticated', 'Not signed in');
    }

    return new app.HttpOk({
      realm: metadata,
      user: {
        id: auth.user.id,
        username: auth.user.username,
        display_name: auth.user.display_name,
      },
      roles: auth.roles,
      expires_at: auth.session.expires_at,
    });
  },
};
