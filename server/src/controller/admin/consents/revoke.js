import { app } from '../../../app.js';
import { authenticateAdminRequest } from '../../../lib/admin-auth.js';
import {
  revokeConsent,
  revokeConsentRefreshTokens,
  splitScopes,
} from '../../../lib/consents.js';
import { HttpError } from '../../../lib/http/http-error.js';
import { getClient } from '../../../lib/oidc/clients.js';
import { findUserById } from '../../../lib/users.js';

function serializeConsent(consent) {
  return {
    user_id: consent.user_id,
    realm_id: consent.realm_id,
    client_id: consent.client_id,
    scopes: splitScopes(consent.scopes),
    granted_via: consent.granted_via,
    created_at: consent.created_at,
    updated_at: consent.updated_at,
    revoked_at: consent.revoked_at,
  };
}

export default {
  method: 'delete',
  path: '/api/v1/admin/realms/:realm/users/:userId/consents/:clientId',
  name: 'admin.consents.revoke',
  async handler(req) {
    const auth = await authenticateAdminRequest(req, {
      realmSlug: req.params.realm,
    });
    const user = await findUserById(auth.systemDb, req.params.userId);
    if (!user) {
      throw new HttpError(404, 'user_not_found', 'User not found');
    }

    const client = await getClient(auth.realmDb, req.params.clientId);
    if (!client || client.system_client) {
      throw new HttpError(404, 'client_not_found', 'Client not found');
    }

    const now = Date.now();
    const consent = await revokeConsent(auth.systemDb, {
      userId: user.id,
      realmId: auth.realm.id,
      clientId: client.client_id,
      now,
    });
    await revokeConsentRefreshTokens(auth.systemDb, {
      userId: user.id,
      realmId: auth.realm.id,
      clientId: client.client_id,
      now,
    });

    return new app.HttpOk(
      { ok: true, consent: serializeConsent(consent) },
      { 'cache-control': 'no-store' }
    );
  },
};
