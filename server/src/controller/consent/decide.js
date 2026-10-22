import { app } from '../../app.js';
import { resolveConsentRequest } from '../../lib/consent-request.js';
import { recordConsent } from '../../lib/consents.js';
import { HttpError } from '../../lib/http/http-error.js';
import { endpointUrls, requestOrigin } from '../../lib/oidc/context.js';
import { clearAuthRequestCookie, deleteAuthRequest } from '../../lib/oidc/requests.js';

function withQuery(url, params) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      target.searchParams.set(key, String(value));
    }
  }
  return target.toString();
}

export default {
  method: 'post',
  path: '/api/v1/consent',
  name: 'consent.decide',
  async handler(req, res) {
    const body = req.body || {};
    if (body.decision !== 'allow' && body.decision !== 'deny') {
      throw new HttpError(400, 'invalid_request', 'decision must be allow or deny');
    }

    const request = await resolveConsentRequest({
      req,
      res,
      publicUrl: app.config.server.public_url,
      clientId: body.client_id,
    });

    if (body.decision === 'deny') {
      const redirect = withQuery(request.pending.redirect_uri, {
        error: 'access_denied',
        error_description: 'The user denied access',
        state: request.pending.state,
      });
      await deleteAuthRequest(request.store, request.pending.id);
      clearAuthRequestCookie(res, req, request.target);
      return new app.HttpOk({ ok: true, redirect }, { 'cache-control': 'no-store' });
    }

    await recordConsent(request.systemDb, {
      userId: request.auth.user.id,
      realmId: request.target.realm.id,
      clientId: request.target.clientId,
      scopes: request.pending.scope,
      grantedVia: 'user',
    });

    const context = {
      ...request.hostContext,
      origin: requestOrigin(req),
      clientId: request.target.clientId,
      realm: request.target.realm,
      systemClient: false,
    };

    return new app.HttpOk(
      { ok: true, redirect: endpointUrls(context).authorize },
      { 'cache-control': 'no-store' }
    );
  },
};
