import crypto from 'node:crypto';
import { app } from '../app.js';
import {
  serveAppDocument,
  systemClientPostLogoutUris,
  systemClientRedirectUris,
} from '../lib/apps.js';
import { isUserBanned } from '../lib/bans.js';
import { consentStatus, getConsent, recordConsent } from '../lib/consents.js';
import { HttpError } from '../lib/http/http-error.js';
import {
  authenticateClient,
  getClient,
  getSystemClient,
  postLogoutRedirectAllowed,
  redirectUriAllowed,
} from '../lib/oidc/clients.js';
import {
  canonicalIssuer,
  endpointBase,
  endpointUrls,
  resolveOidcContext,
  systemIssuer,
} from '../lib/oidc/context.js';
import { getJwks, signToken, verifyToken } from '../lib/oidc/keys.js';
import {
  clearAuthRequestCookie,
  clearAuthRequestSelection,
  completeAuthRequest,
  createAuthRequest,
  createAuthorizationCode,
  deleteAuthRequest,
  getAuthRequest,
  purgeExpired,
  readAuthRequestId,
  selectAuthRequestAccount,
  setAuthRequestCookie,
} from '../lib/oidc/requests.js';
import { canUseClient } from '../lib/policy.js';
import { getSystemDatabase, openRealmDatabase, realmMetadata } from '../lib/realm.js';
import { issueRefreshToken, rotateRefreshToken } from '../lib/refresh-tokens.js';
import {
  authenticateRequest,
  bindSessionRealm,
  clearSessionCookie,
  destroySession,
  findActiveSessionById,
  getSessionRealmBinding,
  listSessionAccounts,
  requestToken,
  sessionMatchesContext,
} from '../lib/session.js';
import { canUseSystemClient } from '../lib/system-clients.js';
import {
  findUserById,
  getMembership,
  getPrimaryEmail,
  getUserRoles,
} from '../lib/users.js';

const ACCESS_TOKEN_TTL = 300;

function oidcError(status, error, description, headers = {}) {
  return new app.HttpResponse(
    status,
    { error, error_description: description },
    { 'cache-control': 'no-store', ...headers }
  );
}

function redirect(res, location) {
  return new app.HttpResponse(302, undefined, { location });
}

function withQuery(url, params) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      target.searchParams.set(key, String(value));
    }
  }
  return target.toString();
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function accessDenied(res, redirectUri, state) {
  return redirect(
    res,
    withQuery(redirectUri, {
      error: 'access_denied',
      error_description: 'The user is not allowed to use this client',
      state,
    })
  );
}

function tokenStore(context, systemDb, realmDb) {
  if (context.systemClient) {
    return { db: systemDb, table: 'system_signing_keys' };
  }
  return { db: realmDb, table: 'signing_keys' };
}

function tokenIssuer(context) {
  return context.systemClient
    ? systemIssuer(app.config.server.public_url)
    : canonicalIssuer(app.config.server.public_url, context.realm.slug);
}

function systemCallbacks(context, client) {
  return client.system_client ? systemClientRedirectUris(context, client.client_id) : [];
}

async function discovery(context, client) {
  const realm = context.realm ? await realmMetadata(context.realm) : null;
  const urls = endpointUrls(context);
  const branding =
    Object.keys(client.branding || {}).length > 0
      ? client.branding
      : realm?.branding || {};
  const scopes = String(client.scopes || 'openid profile email')
    .split(/\s+/)
    .filter(Boolean);

  return new app.HttpOk(
    {
      issuer: tokenIssuer(context),
      client_id: client.client_id,
      client_name: client.name,
      realm: context.realm?.slug ?? null,
      display_name: client.name,
      branding,
      access_mode: client.access_mode,
      system_client: Boolean(client.system_client),
      allow_session_duration_choice: realm?.allow_session_duration_choice ?? true,
      authorization_endpoint: urls.authorize,
      token_endpoint: urls.token,
      userinfo_endpoint: urls.userinfo,
      jwks_uri: urls.jwks,
      end_session_endpoint: urls.logout,
      response_types_supported: ['code'],
      grant_types_supported: client.system_client
        ? ['authorization_code', 'refresh_token']
        : ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      scopes_supported: scopes,
      token_endpoint_auth_methods_supported: [client.token_endpoint_auth_method || 'none'],
      code_challenge_methods_supported: ['S256'],
      claims_supported: [
        'iss',
        'sub',
        'aud',
        'exp',
        'iat',
        'auth_time',
        'nonce',
        'name',
        'preferred_username',
        'email',
        'email_verified',
        'roles',
      ],
      require_pkce: Boolean(client.require_pkce),
    },
    { 'cache-control': 'no-cache' }
  );
}

async function authorize(context, client, req, res) {
  const url = new URL(req.url, context.origin);
  const params = url.searchParams;
  const systemDb = getSystemDatabase();
  const realmDb = context.realm ? await openRealmDatabase(context.realm) : null;
  const store = context.systemClient ? systemDb : realmDb;
  await purgeExpired(store);

  const pendingId = readAuthRequestId(req, context);
  let pending = await getAuthRequest(store, pendingId);
  if (pending && (pending.completed_at || pending.client_id !== client.client_id)) {
    await deleteAuthRequest(store, pending.id);
    clearAuthRequestCookie(res, req, context);
    pending = null;
  }

  const callbacks = systemCallbacks(context, client);
  let redirectUri = params.get('redirect_uri');
  let state = params.get('state');
  let scope = params.get('scope');
  let nonce = params.get('nonce');
  let codeChallenge = params.get('code_challenge');
  let codeChallengeMethod = params.get('code_challenge_method');
  const requestedClientId = params.get('client_id');

  const fail = (error, description) => {
    const target = pending?.redirect_uri || redirectUri;
    if (!target) return oidcError(400, error, description);
    return redirect(
      res,
      withQuery(target, {
        error,
        error_description: description,
        state: pending?.state || state,
      })
    );
  };

  if (pending) {
    const mismatch =
      (redirectUri && redirectUri !== pending.redirect_uri) ||
      (requestedClientId && requestedClientId !== pending.client_id) ||
      (params.has('response_type') && params.get('response_type') !== 'code') ||
      (scope && scope !== pending.scope) ||
      (params.has('state') && state !== pending.state) ||
      (params.has('nonce') && nonce !== pending.nonce) ||
      (codeChallenge && codeChallenge !== pending.code_challenge) ||
      (codeChallengeMethod && codeChallengeMethod !== pending.code_challenge_method);

    if (mismatch) {
      await deleteAuthRequest(store, pending.id);
      clearAuthRequestCookie(res, req, context);
      pending = null;
    } else {
      redirectUri = pending.redirect_uri;
      state = pending.state;
      scope = pending.scope;
      nonce = pending.nonce;
      codeChallenge = pending.code_challenge;
      codeChallengeMethod = pending.code_challenge_method;
    }
  }

  if (!pending) {
    if (!redirectUri) {
      return oidcError(400, 'invalid_request', 'redirect_uri is required');
    }
    if (!redirectUriAllowed(client, redirectUri, callbacks)) {
      return oidcError(400, 'invalid_request', 'redirect_uri is not registered');
    }
    if (params.get('response_type') !== 'code') {
      return fail('unsupported_response_type', 'Only response_type=code is supported');
    }
    if ((requestedClientId || context.clientId) !== client.client_id) {
      return fail('invalid_request', 'client_id does not match the requested client');
    }
    if (!scope) scope = 'openid';
    if (!scope.split(/\s+/).includes('openid')) {
      return fail('invalid_scope', 'The openid scope is required');
    }
    if (client.require_pkce && (!codeChallenge || codeChallengeMethod !== 'S256')) {
      return fail('invalid_request', 'PKCE with S256 is required');
    }
  }

  const auth = await authenticateRequest({
    systemDb,
    realmDb,
    req,
    res,
    context,
  });

  let allowed = false;
  if (auth) {
    if (client.system_client) {
      allowed = await canUseSystemClient(systemDb, { user: auth.user, client });
    } else {
      allowed =
        canUseClient({
          user: auth.user,
          membership: auth.membership,
          roles: auth.roles,
          client,
          realm: context.realm,
        }) &&
        !(await isUserBanned(realmDb, {
          userId: auth.user.id,
          clientId: client.client_id,
        }));
    }
  }

  if (auth && !allowed) {
    if (pending) {
      await deleteAuthRequest(store, pending.id);
      clearAuthRequestCookie(res, req, context);
    }
    return accessDenied(res, redirectUri, state);
  }

  if (!pending) {
    pending = {
      id: await createAuthRequest(store, {
        clientId: client.client_id,
        redirectUri,
        scope,
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod,
      }),
    };

    if (!auth) {
      setAuthRequestCookie(res, req, context, pending.id);
      return redirect(res, endpointUrls(context).login);
    }
  }

  if (!auth) {
    setAuthRequestCookie(res, req, context, pending.id);
    return redirect(res, endpointUrls(context).login);
  }

  const accounts = await listSessionAccounts(systemDb, auth.group);
  const selected = Boolean(
    pending.user_id &&
      pending.session_id &&
      pending.session_id === auth.session.id &&
      pending.user_id === auth.user.id
  );
  if ((pending.user_id || pending.session_id) && !selected) {
    await clearAuthRequestSelection(store, pending.id);
  }
  if (!selected && accounts.length >= 2) {
    setAuthRequestCookie(res, req, context, pending.id);
    return redirect(res, endpointUrls(context).login);
  }

  if (context.realm) {
    const binding = await getSessionRealmBinding(
      systemDb,
      auth.session.id,
      context.realm.id
    );
    if (binding?.revoked_at) {
      await clearAuthRequestSelection(store, pending.id);
      setAuthRequestCookie(res, req, context, pending.id);
      const login = new URL(endpointUrls(context).login);
      login.searchParams.set('reauth', '1');
      return redirect(res, login.toString());
    }
    await bindSessionRealm(systemDb, auth.session.id, context.realm.id);
  }

  const consent = client.system_client
    ? null
    : await getConsent(systemDb, {
        userId: auth.user.id,
        realmId: context.realm.id,
        clientId: client.client_id,
      });
  const consentState = consentStatus({
    client,
    user: auth.user,
    realm: context.realm,
    consent,
    scope,
  });

  if (consentState.required) {
    await selectAuthRequestAccount(store, pending.id, {
      userId: auth.user.id,
      sessionId: auth.session.id,
      authTime: auth.session.auth_time,
    });
    setAuthRequestCookie(res, req, context, pending.id);
    return redirect(res, endpointUrls(context).consent);
  }

  if (consentState.autoGrant) {
    await recordConsent(systemDb, {
      userId: auth.user.id,
      realmId: context.realm.id,
      clientId: client.client_id,
      scopes: scope,
      grantedVia: 'trusted',
    });
  }

  await completeAuthRequest(store, pending.id, {
    userId: auth.user.id,
    sessionId: auth.session.id,
    authTime: auth.session.auth_time,
  });

  const request = await getAuthRequest(store, pending.id);
  const code = await createAuthorizationCode(store, request);
  await deleteAuthRequest(store, pending.id);
  clearAuthRequestCookie(res, req, context);

  return redirect(res, withQuery(redirectUri, { code, state }));
}

function verifyPkce(codeVerifier, challenge) {
  if (!codeVerifier || !challenge) return false;
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const left = Buffer.from(computed);
  const right = Buffer.from(challenge);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function accessTokenResponse({
  systemDb,
  realmDb,
  context,
  client,
  user,
  scope,
  sessionId,
  authTime,
  nonce,
  includeIdToken = true,
}) {
  const store = tokenStore(context, systemDb, realmDb);
  const issuer = tokenIssuer(context);
  const email = await getPrimaryEmail(systemDb, user.id);
  const roles = context.systemClient ? [] : await getUserRoles(realmDb, user.id);

  const accessClaims = {
    sub: user.id,
    client_id: client.client_id,
    scope,
    roles,
    sid: sessionId || undefined,
  };
  const accessToken = await signToken(store.db, accessClaims, {
    issuer,
    audience: client.client_id,
    expiresIn: ACCESS_TOKEN_TTL,
    table: store.table,
  });

  const response = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL,
    scope,
  };

  if (includeIdToken) {
    const idClaims = {
      sub: user.id,
      email: email?.email,
      email_verified: Boolean(email?.verified),
      name: user.display_name || user.username,
      preferred_username: user.username,
      roles,
      auth_time: authTime,
      sid: sessionId || undefined,
      nonce: nonce || undefined,
    };
    response.id_token = await signToken(store.db, idClaims, {
      issuer,
      audience: client.client_id,
      expiresIn: ACCESS_TOKEN_TTL,
      table: store.table,
    });
  }

  return response;
}

async function token(context, client, req) {
  if (req.method !== 'POST') {
    return oidcError(405, 'invalid_request', 'POST is required');
  }

  const body = req.body || {};
  if (!authenticateClient(req, client, body)) {
    return oidcError(401, 'invalid_client', 'Client authentication failed', {
      'www-authenticate': 'Basic realm="oidc"',
    });
  }

  const systemDb = getSystemDatabase();
  const realmDb = context.realm ? await openRealmDatabase(context.realm) : null;
  const store = tokenStore(context, systemDb, realmDb);

  if (body.grant_type === 'authorization_code') {
    const code = await store.db.get(
      `SELECT id, auth_request_id, client_id, user_id, redirect_uri, scope, nonce,
              code_challenge, code_challenge_method, session_id, auth_time,
              expires_at, consumed_at
         FROM authorization_codes
        WHERE id = {id}`,
      { id: crypto.createHash('sha256').update(String(body.code || '')).digest('hex') }
    );

    if (
      !code ||
      code.consumed_at ||
      code.expires_at <= Date.now() ||
      code.client_id !== client.client_id
    ) {
      return oidcError(400, 'invalid_grant', 'The authorization code is invalid');
    }
    if (body.redirect_uri !== code.redirect_uri) {
      return oidcError(400, 'invalid_grant', 'redirect_uri does not match');
    }
    if (code.code_challenge) {
      if (
        code.code_challenge_method !== 'S256' ||
        !verifyPkce(body.code_verifier, code.code_challenge)
      ) {
        return oidcError(400, 'invalid_grant', 'PKCE verification failed');
      }
    } else if (client.require_pkce) {
      return oidcError(400, 'invalid_grant', 'PKCE is required');
    }

    await store.db.run('UPDATE authorization_codes SET consumed_at = {now} WHERE id = {id}', {
      now: Date.now(),
      id: code.id,
    });

    const user = await findUserById(systemDb, code.user_id);
    if (!user || user.status !== 'active') {
      return oidcError(400, 'invalid_grant', 'The user is not available');
    }

    if (client.system_client) {
      if (!(await canUseSystemClient(systemDb, { user, client }))) {
        return oidcError(400, 'invalid_grant', 'The user no longer has access to this client');
      }
    } else {
      const membership = await getMembership(realmDb, user.id);
      const roles = await getUserRoles(realmDb, user.id);
      if (
        !canUseClient({
          user,
          membership,
          roles,
          client,
          realm: context.realm,
        }) ||
        (await isUserBanned(realmDb, {
          userId: user.id,
          clientId: client.client_id,
        }))
      ) {
        return oidcError(400, 'invalid_grant', 'The user no longer has access to this client');
      }
    }

    if (!client.system_client) {
      const consent = await getConsent(systemDb, {
        userId: user.id,
        realmId: context.realm.id,
        clientId: client.client_id,
      });
      const consentState = consentStatus({
        client,
        user,
        realm: context.realm,
        consent,
        scope: code.scope,
      });
      if (consentState.required) {
        return oidcError(400, 'invalid_grant', 'The user has not consented to this client');
      }
      if (consentState.autoGrant) {
        await recordConsent(systemDb, {
          userId: user.id,
          realmId: context.realm.id,
          clientId: client.client_id,
          scopes: code.scope,
          grantedVia: 'trusted',
        });
      }
    }

    const response = await accessTokenResponse({
      systemDb,
      realmDb,
      context,
      client,
      user,
      scope: code.scope,
      sessionId: code.session_id,
      authTime: code.auth_time,
      nonce: code.nonce,
    });

    if (client.system_client && code.session_id) {
      const refresh = await issueRefreshToken(systemDb, {
        sessionId: code.session_id,
        userId: user.id,
        realmId: context.realm?.id ?? null,
        clientId: client.client_id,
        scopes: code.scope,
      });
      response.refresh_token = refresh.token;
    }

    return new app.HttpOk(response, { 'cache-control': 'no-store' });
  }

  if (body.grant_type === 'refresh_token') {
    if (!client.system_client) {
      return oidcError(400, 'unsupported_grant_type', 'Only authorization_code is supported');
    }

    const rotated = await rotateRefreshToken(systemDb, body.refresh_token, {
      async validate(row, tx) {
        if (row.client_id !== client.client_id) return false;
        if (row.realm_id !== (context.realm?.id ?? null)) return false;

        const session = await findActiveSessionById(tx, row.session_id);
        if (!session || session.user_id !== row.user_id) return false;
        if (!sessionMatchesContext(session, context)) return false;

        const user = await findUserById(tx, row.user_id);
        if (!user || user.status !== 'active') return false;

        if (client.system_client) {
          if (!(await canUseSystemClient(tx, { user, client }))) return false;
        } else {
          const consent = await getConsent(tx, {
            userId: row.user_id,
            realmId: row.realm_id,
            clientId: row.client_id,
          });
          const consentState = consentStatus({
            client,
            user,
            realm: context.realm,
            consent,
            scope: row.scopes,
          });
          if (consentState.required) return false;
        }

        if (row.realm_id) {
          if (
            !client.system_client &&
            (!realmDb ||
              (await isUserBanned(realmDb, {
                userId: row.user_id,
                clientId: row.client_id,
              })))
          ) {
            return false;
          }
          const binding = await getSessionRealmBinding(tx, row.session_id, row.realm_id);
          if (!binding || binding.revoked_at) return false;
        }
        return true;
      },
    });

    if (rotated.status !== 'ok') {
      return oidcError(400, 'invalid_grant', 'The refresh token is invalid');
    }

    const user = await findUserById(systemDb, rotated.row.user_id);
    if (!user || user.status !== 'active') {
      return oidcError(400, 'invalid_grant', 'The user is not available');
    }

    const response = await accessTokenResponse({
      systemDb,
      realmDb,
      context,
      client,
      user,
      scope: rotated.row.scopes,
      sessionId: rotated.row.session_id,
      includeIdToken: false,
    });
    response.refresh_token = rotated.token;
    return new app.HttpOk(response, { 'cache-control': 'no-store' });
  }

  return oidcError(400, 'unsupported_grant_type', 'Only authorization_code is supported');
}

async function userinfo(context, client, req) {
  const tokenValue = bearerToken(req);
  if (!tokenValue) {
    return oidcError(401, 'invalid_token', 'A bearer token is required', {
      'www-authenticate': 'Bearer',
    });
  }

  const systemDb = getSystemDatabase();
  const realmDb = context.realm ? await openRealmDatabase(context.realm) : null;
  const store = tokenStore(context, systemDb, realmDb);
  let payload;
  try {
    payload = await verifyToken(store.db, tokenValue, {
      issuer: tokenIssuer(context),
      audience: client.client_id,
      table: store.table,
    });
  } catch {
    return oidcError(401, 'invalid_token', 'The access token is invalid', {
      'www-authenticate': 'Bearer error="invalid_token"',
    });
  }

  if (payload.client_id !== client.client_id || !payload.sub) {
    return oidcError(401, 'invalid_token', 'The access token does not belong to this client', {
      'www-authenticate': 'Bearer error="invalid_token"',
    });
  }

  const user = await findUserById(systemDb, payload.sub);
  if (!user || user.status !== 'active') {
    return oidcError(401, 'invalid_token', 'The user is not available');
  }
  if (client.system_client && !(await canUseSystemClient(systemDb, { user, client }))) {
    return oidcError(401, 'invalid_token', 'The user no longer has access to this client');
  }
  if (
    !client.system_client &&
    (!realmDb ||
      (await isUserBanned(realmDb, {
        userId: user.id,
        clientId: client.client_id,
      })))
  ) {
    return oidcError(401, 'invalid_token', 'The user no longer has access to this client');
  }

  const email = await getPrimaryEmail(systemDb, user.id);
  const roles = client.system_client ? [] : await getUserRoles(realmDb, user.id);

  return new app.HttpOk({
    sub: user.id,
    name: user.display_name || user.username,
    preferred_username: user.username,
    email: email?.email,
    email_verified: Boolean(email?.verified),
    roles,
    is_system_admin: Boolean(user.is_system_admin),
  });
}

async function logout(context, client, req, res) {
  const url = new URL(req.url, context.origin);
  const postLogoutUri = url.searchParams.get('post_logout_redirect_uri');
  const state = url.searchParams.get('state');
  const callbacks = client.system_client
    ? systemClientPostLogoutUris(context, client.client_id)
    : [];

  if (!postLogoutRedirectAllowed(client, postLogoutUri, callbacks)) {
    return oidcError(400, 'invalid_request', 'post_logout_redirect_uri is not registered');
  }

  const systemDb = getSystemDatabase();
  const realmDb = context.realm ? await openRealmDatabase(context.realm) : null;
  const store = tokenStore(context, systemDb, realmDb);
  const idTokenHint = url.searchParams.get('id_token_hint');
  if (idTokenHint) {
    try {
      await verifyToken(store.db, idTokenHint, {
        issuer: tokenIssuer(context),
        audience: client.client_id,
        table: store.table,
      });
    } catch {
      return oidcError(400, 'invalid_request', 'id_token_hint is invalid');
    }
  }

  const result = await destroySession(systemDb, requestToken(req));
  if (result.groupDeleted) clearSessionCookie(res, req);
  clearAuthRequestCookie(res, req, context);

  if (postLogoutUri) {
    return redirect(res, withQuery(postLogoutUri, { state }));
  }
  return new app.HttpOk({ ok: true });
}

export default {
  mount: '/oidc',
  name: 'oidc',
  async handler(req, res) {
    try {
      const context = await resolveOidcContext(req, {
        publicUrl: app.config.server.public_url,
      });
      if (context.action === 'login' || context.action === 'consent') {
        serveAppDocument(res, 'login');
        return;
      }
      if (context.action === 'callback') {
        throw new HttpError(404, 'not_found', 'Not found');
      }

      const systemDb = getSystemDatabase();
      const realmDb = context.realm ? await openRealmDatabase(context.realm) : null;
      const client = context.systemClient
        ? getSystemClient(context.clientId)
        : await getClient(realmDb, context.clientId);
      if (!client || !client.enabled) {
        throw new HttpError(404, 'unknown_client', 'Unknown client');
      }

      let result;
      switch (context.action) {
        case 'openid-configuration':
          result = await discovery(context, client);
          break;
        case 'jwks':
          result = context.systemClient
            ? new app.HttpOk(await getJwks(systemDb, { table: 'system_signing_keys' }))
            : new app.HttpOk(await getJwks(realmDb));
          break;
        case 'authorize':
          result = await authorize(context, client, req, res);
          break;
        case 'token':
          result = await token(context, client, req);
          break;
        case 'userinfo':
          result = await userinfo(context, client, req);
          break;
        case 'logout':
          result = await logout(context, client, req, res);
          break;
        default:
          throw new HttpError(404, 'not_found', 'Not found');
      }

      if (result) result.send(res);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof app.HttpError) {
        e.toResponse().send(res);
        return;
      }
      console.error(e);
      new app.HttpError(500, 'internal_error', 'Internal server error').toResponse().send(res);
    }
  },
};
