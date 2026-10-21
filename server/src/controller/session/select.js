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
    const systemDb = getSystemDatabase();
    let target = {
      realm: hostContext.realm || null,
      clientId: hostContext.clientId || null,
      systemClient: false,
    };
    if (body.client_id) {
      target = await resolveClientForHost(hostContext, body.client_id);
    }

    const selected = await selectSessionAccount(systemDb, {
      token: requestToken(req),
      context: hostContext,
      publicId: body.public_id,
    });
    if (!selected) {
      throw new HttpError(401, 'not_authenticated', 'Not signed in');
    }

    let pendingAuthRequest = false;
    const store = target.systemClient
      ? systemDb
      : target.realm
        ? await openRealmDatabase(target.realm)
        : null;
    if (store) {
      const pending = await getAuthRequest(store, readAuthRequestId(req, target));
      if (
        pending &&
        !pending.completed_at &&
        (!target.clientId || pending.client_id === target.clientId)
      ) {
        await selectAuthRequestAccount(store, pending.id, {
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
