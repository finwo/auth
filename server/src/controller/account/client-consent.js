import { app } from '../../app.js';
import {
  getConsent,
  revokeConsent,
  revokeConsentRefreshTokens,
  splitScopes,
} from '../../lib/consents.js';
import { resolveHostContext } from '../../lib/host-context.js';
import { HttpError } from '../../lib/http/http-error.js';
import { getClient } from '../../lib/oidc/clients.js';
import { canonicalBaseUrl } from '../../lib/oidc/context.js';
import { getSystemDatabase, openRealmDatabase, realmMetadata } from '../../lib/realm.js';
import { authenticateRequest } from '../../lib/session.js';

async function resolveClientAccount(req, res, clientId) {
  const hostContext = await resolveHostContext(req, {
    publicUrl: app.config.server.public_url,
  });
  if (hostContext.mode !== 'client' || hostContext.clientId !== clientId) {
    throw new HttpError(404, 'not_found', 'Not found');
  }

  const realmDb = await openRealmDatabase(hostContext.realm);
  const systemDb = getSystemDatabase();
  const client = await getClient(realmDb, hostContext.clientId);
  if (!client || !client.enabled) {
    throw new HttpError(404, 'unknown_client', 'Unknown client');
  }

  const auth = await authenticateRequest({
    systemDb,
    realmDb,
    req,
    res,
    context: hostContext,
  });
  if (!auth) {
    throw new HttpError(401, 'not_authenticated', 'Not signed in');
  }

  return { hostContext, realmDb, systemDb, client, auth };
}

async function consentResponse({ hostContext, systemDb, client, auth }) {
  const consent = await getConsent(systemDb, {
    userId: auth.user.id,
    realmId: hostContext.realm.id,
    clientId: client.client_id,
  });
  const realm = await realmMetadata(hostContext.realm);

  return {
    client: {
      id: client.client_id,
      name: client.name,
    },
    realm,
    user: {
      id: auth.user.id,
      username: auth.user.username,
      display_name: auth.user.display_name,
    },
    scopes: splitScopes(consent?.scopes),
    account_url: `${canonicalBaseUrl(app.config.server.public_url)}/app/account`,
    active: Boolean(consent && !consent.revoked_at),
    consent: consent
      ? {
          granted_via: consent.granted_via,
          created_at: consent.created_at,
          updated_at: consent.updated_at,
          revoked_at: consent.revoked_at,
        }
      : null,
  };
}

export default [
  {
    method: 'get',
    path: '/api/v1/account/clients/:clientId/consent',
    name: 'account.client_consent.show',
    async handler(req, res) {
      const context = await resolveClientAccount(req, res, req.params.clientId);
      return new app.HttpOk(await consentResponse(context), {
        'cache-control': 'no-store',
      });
    },
  },
  {
    method: 'delete',
    path: '/api/v1/account/clients/:clientId/consent',
    name: 'account.client_consent.revoke',
    async handler(req, res) {
      const context = await resolveClientAccount(req, res, req.params.clientId);
      const now = Date.now();
      const consent = await revokeConsent(context.systemDb, {
        userId: context.auth.user.id,
        realmId: context.hostContext.realm.id,
        clientId: context.client.client_id,
        now,
      });
      await revokeConsentRefreshTokens(context.systemDb, {
        userId: context.auth.user.id,
        realmId: context.hostContext.realm.id,
        clientId: context.client.client_id,
        now,
      });

      return new app.HttpOk(
        {
          ...(await consentResponse(context)),
          ok: true,
          revoked_at: consent.revoked_at,
        },
        { 'cache-control': 'no-store' }
      );
    },
  },
];
