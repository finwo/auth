import { app } from '../../app.js';
import { openRealmDatabase, resolveRealm } from '../../lib/realm.js';
import { clearSessionCookie, destroySession, requestToken } from '../../lib/session.js';

export default {
  method: 'post',
  path: '/api/v1/logout',
  name: 'login.logout',
  async handler(req, res) {
    const body = req.body || {};
    const realm = await resolveRealm({
      host: req.headers.host,
      slug: body.realm || undefined,
    });
    const realmDb = await openRealmDatabase(realm);
    const token = requestToken(req, realm);

    await destroySession(realmDb, token);
    clearSessionCookie(res, req, realm);

    return new app.HttpOk({ ok: true });
  },
};
