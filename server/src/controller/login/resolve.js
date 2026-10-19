import { app } from '../../app.js';
import { resolveLogin } from '../../lib/login.js';
import { HttpError } from '../../lib/http/http-error.js';
import { openRealmDatabase, realmMetadata, resolveRealm } from '../../lib/realm.js';

export default {
  method: 'post',
  path: '/api/v1/login/resolve',
  name: 'login.resolve',
  async handler(req) {
    const body = req.body || {};
    if (typeof body.identifier !== 'string') {
      throw new HttpError(400, 'invalid_request', 'identifier is required');
    }
    if (body.realm != null && typeof body.realm !== 'string') {
      throw new HttpError(400, 'invalid_request', 'realm must be a string');
    }

    const realm = await resolveRealm({
      host: req.headers.host,
      slug: body.realm || undefined,
    });
    const metadata = await realmMetadata(realm);
    const db = await openRealmDatabase(realm);
    const result = await resolveLogin(db, body.identifier);

    return new app.HttpOk({
      realm: metadata,
      ...result,
    });
  },
};
