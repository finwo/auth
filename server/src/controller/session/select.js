import { app } from '../../app.js';
import { resolveClientForHost, resolveHostContext } from '../../lib/host-context.js';
import { HttpError } from '../../lib/http/http-error.js';
import {
  getAuthRequest,
  readAuthRequestId,
  selectAuthRequestAccount,
} from '../../lib/oidc/requests.js';
import { getSystemDatabase, openRealmDatabase } from '../../lib/realm.js';
import { requestToken, selectSessionAccount } from '../../lib/session.js';

export default {
  method: 'post',
  path: '/api/v1/session/select',
  name: 'session.select',
  async handler(req) {
    const body = req.body || {};
    if (typeof body.public_id !== 'string') {
      throw new HttpError(400, 'invalid_request', 'public_id is required');
    }
    if (body.client_id != null && typeof body.client_id !== 'string') {
      throw new HttpError(400, 'invalid_request', 'client_id must be a string');
    }

    const hostContext = await resolveHostContext(req, {
      publicUrl: app.config.server.public_url,
    });
    let realm = hostContext.realm || null;
    let clientId = body.client_id || hostContext.clientId || null;
    if (body.client_id && hostContext.mode !== 'client') {
      const resolved = await resolveClientForHost(hostContext, body.client_id);
      realm = resolved.realm;
      clientId = resolved.clientId;
    }

    const selected = await selectSessionAccount(getSystemDatabase(), {
      token: requestToken(req),
      context: hostContext,
      publicId: body.public_id,
    });
    if (!selected) {
      throw new HttpError(401, 'not_authenticated', 'Not signed in');
    }

    let pendingAuthRequest = false;
    if (realm) {
      const realmDb = await openRealmDatabase(realm);
      const pending = await getAuthRequest(realmDb, readAuthRequestId(req, realm));
      if (
        pending &&
        !pending.completed_at &&
        (!clientId || pending.client_id === clientId)
      ) {
        await selectAuthRequestAccount(realmDb, pending.id, {
          userId: selected.user.id,
          sessionId: selected.session.id,
          authTime: selected.session.auth_time,
        });
        pendingAuthRequest = true;
      }
    }

    return new app.HttpOk({
      ok: true,
      user: {
        id: selected.user.id,
        username: selected.user.username,
        display_name: selected.user.display_name,
      },
      expires_at: selected.session.expires_at,
      pending_auth_request: pendingAuthRequest,
    });
  },
};
