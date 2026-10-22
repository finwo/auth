import { app } from '../../app.js';
import { resolveConsentRequest } from '../../lib/consent-request.js';
import { splitScopes } from '../../lib/consents.js';
import { realmMetadata } from '../../lib/realm.js';

export default {
  method: 'get',
  path: '/api/v1/consent',
  name: 'consent.show',
  async handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const request = await resolveConsentRequest({
      req,
      res,
      publicUrl: app.config.server.public_url,
      clientId: url.searchParams.get('client_id'),
    });
    const realm = await realmMetadata(request.target.realm);

    return new app.HttpOk(
      {
        client: {
          id: request.client.client_id,
          name: request.client.name,
        },
        realm,
        user: {
          id: request.auth.user.id,
          username: request.auth.user.username,
          display_name: request.auth.user.display_name,
        },
        scopes: splitScopes(request.pending.scope),
        consent_mode: request.client.consent_mode,
      },
      { 'cache-control': 'no-store' }
    );
  },
};
