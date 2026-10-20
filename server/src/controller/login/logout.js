import { app } from '../../app.js';
import { resolveHostContext } from '../../lib/host-context.js';
import { getSystemDatabase } from '../../lib/realm.js';
import {
  clearSessionCookie,
  destroySession,
  requestToken,
} from '../../lib/session.js';

export default {
  method: 'post',
  path: '/api/v1/logout',
  name: 'login.logout',
  async handler(req, res) {
    await resolveHostContext(req, { publicUrl: app.config.server.public_url });

    const systemDb = getSystemDatabase();
    const result = await destroySession(systemDb, requestToken(req));
    if (result.groupDeleted) clearSessionCookie(res, req);

    return new app.HttpOk({ ok: true });
  },
};
