import { app } from '../../app.js';
import { resolveClientForHost, resolveHostContext } from '../../lib/host-context.js';
import { resolveLogin } from '../../lib/login.js';
import { getClient, getSystemClient } from '../../lib/oidc/clients.js';
import { HttpError } from '../../lib/http/http-error.js';
import { openRealmDatabase, realmMetadata } from '../../lib/realm.js';

export default {
  method: 'post',
  path: '/api/v1/login/resolve',
  name: 'login.resolve',
  async handler(req) {
    const body = req.body || {};
    if (typeof body.identifier !== 'string') {
      throw new HttpError(400, 'invalid_request', 'identifier is required');
    }
    if (typeof body.client_id !== 'string') {
      throw new HttpError(400, 'invalid_request', 'client_id is required');
    }

    const hostContext = await resolveHostContext(req, {
      publicUrl: app.config.server.public_url,
    });
    const { realm, clientId, systemClient } = await resolveClientForHost(
      hostContext,
      body.client_id
    );
    const realmDb = realm ? await openRealmDatabase(realm) : null;
    const client = systemClient
      ? getSystemClient(clientId)
      : await getClient(realmDb, clientId);
    if (!client || !client.enabled) {
      throw new HttpError(404, 'unknown_client', 'Unknown client');
    }

    const metadata = realm ? await realmMetadata(realm) : null;
    const result = await resolveLogin({ identifier: body.identifier });

    return new app.HttpOk({
      realm: metadata,
      ...result,
    });
  },
};
