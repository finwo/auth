import crypto from 'node:crypto';
import { app } from '../app.js';
import { HttpError } from '../lib/http/http-error.js';
import {
  authenticateClient,
  getClient,
  postLogoutRedirectAllowed,
  redirectUriAllowed,
} from '../lib/oidc/clients.js';
import {
  canonicalIssuer,
  endpointBase,
  endpointUrls,
  resolveOidcContext,
} from '../lib/oidc/context.js';
import { getJwks, signToken, verifyToken } from '../lib/oidc/keys.js';
import {
  clearAuthRequestCookie,
  completeAuthRequest,
  createAuthRequest,
  createAuthorizationCode,
  deleteAuthRequest,
  getAuthRequest,
  purgeExpired,
  readAuthRequestId,
  setAuthRequestCookie,
} from '../lib/oidc/requests.js';
import { canUseClient } from '../lib/policy.js';
import {
  getSystemDatabase,
  openRealmDatabase,
  realmMetadata,
} from '../lib/realm.js';
import {
  authenticateRequest,
  clearSessionCookie,
  destroySession,
  requestToken,
} from '../lib/session.js';
import {
  findUserById,
  getMembership,
  getPrimaryEmail,
  getUserRoles,
} from '../lib/users.js';

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

async function discovery(context, client) {
  const realm = await realmMetadata(context.realm);
  const publicUrl = app.config.server.public_url;
  const urls = endpointUrls(context);
  const branding = Object.keys(client.branding || {}).length > 0 ? client.branding : realm.branding;
  const scopes = String(client.scopes || 'openid profile email')
    .split(/\s+/)
    .filter(Boolean);

  return new app.HttpOk(
    {
      issuer: canonicalIssuer(publicUrl, context.realm.slug),
      client_id: client.client_id,
      client_name: client.name,
      realm: context.realm.slug,
      display_name: client.name,
      branding,
      access_mode: client.access_mode,
      virtual: Boolean(client.virtual),
      allow_session_duration_choice: realm.allow_session_duration_choice,
      authorization_endpoint: urls.authorize,
      token_endpoint: urls.token,
      userinfo_endpoint: urls.userinfo,
      jwks_uri: urls.jwks,
      end_session_endpoint: urls.logout,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
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
  const redirectUri = params.get('redirect_uri');
  const state = params.get('state');
  const scope = params.get('scope') || 'openid';
  const clientId = params.get('client_id') || context.clientId;
  const virtualCallbacks = [
    `${endpointBase(context)}/callback`,
    `${context.origin}/app/${client.client_id}/callback`,
  ];

  if (!redirectUri) {
    return oidcError(400, 'invalid_request', 'redirect_uri is required');
  }
  if (!redirectUriAllowed(client, redirectUri, virtualCallbacks)) {
    return oidcError(400, 'invalid_request', 'redirect_uri is not registered');
  }

  const fail = (error, description) =>
    redirect(res, withQuery(redirectUri, { error, error_description: description, state }));

  if (params.get('response_type') !== 'code') {
    return fail('unsupported_response_type', 'Only response_type=code is supported');
  }
  if (clientId !== client.client_id) {
    return fail('invalid_request', 'client_id does not match the requested client');
  }
  if (!scope.split(/\s+/).includes('openid')) {
    return fail('invalid_scope', 'The openid scope is required');
  }

  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method');
  if (client.require_pkce && (!codeChallenge || codeChallengeMethod !== 'S256')) {
    return fail('invalid_request', 'PKCE with S256 is required');
  }

  const db = await openRealmDatabase(context.realm);
  const systemDb = getSystemDatabase();
  await purgeExpired(db);

  const pendingId = readAuthRequestId(req, context.realm);
  let pending = await getAuthRequest(db, pendingId);
  if (
    pending &&
    (pending.client_id !== client.client_id ||
      pending.redirect_uri !== redirectUri ||
      pending.completed_at)
  ) {
    await deleteAuthRequest(db, pending.id);
    pending = null;
  }

  const auth = await authenticateRequest({
    systemDb,
    realmDb: db,
    req,
    res,
    realm: context.realm,
  });

  const allowed = auth
    ? canUseClient({
        user: auth.user,
        membership: auth.membership,
        roles: auth.roles,
        client,
        realm: context.realm,
      })
    : false;

  if (auth && !allowed) {
    if (pending) {
      await deleteAuthRequest(db, pending.id);
      clearAuthRequestCookie(res, req, context.realm);
    }
    return accessDenied(res, redirectUri, state);
  }

  if (!pending) {
    pending = {
      id: await createAuthRequest(db, {
        clientId: client.client_id,
        redirectUri,
        scope,
        state,
        nonce: params.get('nonce'),
        codeChallenge,
        codeChallengeMethod,
      }),
    };

    if (!auth) {
      setAuthRequestCookie(res, req, context.realm, pending.id);
      return redirect(res, endpointUrls(context).login);
    }
  }

  if (!auth) {
    setAuthRequestCookie(res, req, context.realm, pending.id);
    return redirect(res, endpointUrls(context).login);
  }

  const authTime = Math.floor(auth.session.created_at / 1000);
  await completeAuthRequest(db, pending.id, {
    userId: auth.user.id,
    sessionId: auth.session.id,
    authTime,
  });

  const request = await getAuthRequest(db, pending.id);
  const code = await createAuthorizationCode(db, request);
  await deleteAuthRequest(db, pending.id);
  clearAuthRequestCookie(res, req, context.realm);

  return redirect(res, withQuery(redirectUri, { code, state }));
}

function verifyPkce(codeVerifier, challenge) {
  if (!codeVerifier || !challenge) return false;
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const left = Buffer.from(computed);
  const right = Buffer.from(challenge);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
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
  if (body.grant_type !== 'authorization_code') {
    return oidcError(400, 'unsupported_grant_type', 'Only authorization_code is supported');
  }

  const db = await openRealmDatabase(context.realm);
  const systemDb = getSystemDatabase();
  const code = await db.get(
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

  await db.run('UPDATE authorization_codes SET consumed_at = {now} WHERE id = {id}', {
    now: Date.now(),
    id: code.id,
  });

  const user = await findUserById(systemDb, code.user_id);
  if (!user || user.status !== 'active') {
    return oidcError(400, 'invalid_grant', 'The user is not available');
  }

  const membership = await getMembership(db, user.id);
  const roles = await getUserRoles(db, user.id);
  if (
    !canUseClient({
      user,
      membership,
      roles,
      client,
      realm: context.realm,
    })
  ) {
    return oidcError(400, 'invalid_grant', 'The user no longer has access to this client');
  }

  const email = await getPrimaryEmail(systemDb, user.id);
  const issuer = canonicalIssuer(app.config.server.public_url, context.realm.slug);
  const audience = client.client_id;
  const expiresIn = 300;

  const idClaims = {
    sub: user.id,
    email: email?.email,
    email_verified: Boolean(email?.verified),
    name: user.display_name || user.username,
    preferred_username: user.username,
    roles,
    auth_time: code.auth_time,
    sid: code.session_id || undefined,
    nonce: code.nonce || undefined,
  };

  const accessClaims = {
    sub: user.id,
    client_id: client.client_id,
    scope: code.scope,
    roles,
    sid: code.session_id || undefined,
  };

  const idToken = await signToken(db, idClaims, { issuer, audience, expiresIn });
  const accessToken = await signToken(db, accessClaims, { issuer, audience, expiresIn });

  return new app.HttpOk(
    {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      id_token: idToken,
      scope: code.scope,
    },
    { 'cache-control': 'no-store' }
  );
}

async function userinfo(context, client, req) {
  const tokenValue = bearerToken(req);
  if (!tokenValue) {
    return oidcError(401, 'invalid_token', 'A bearer token is required', {
      'www-authenticate': 'Bearer',
    });
  }

  const db = await openRealmDatabase(context.realm);
  const issuer = canonicalIssuer(app.config.server.public_url, context.realm.slug);
  let payload;
  try {
    payload = await verifyToken(db, tokenValue, {
      issuer,
      audience: client.client_id,
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

  const systemDb = getSystemDatabase();
  const user = await findUserById(systemDb, payload.sub);
  if (!user || user.status !== 'active') {
    return oidcError(401, 'invalid_token', 'The user is not available');
  }

  const email = await getPrimaryEmail(systemDb, user.id);
  const roles = await getUserRoles(db, user.id);

  return new app.HttpOk({
    sub: user.id,
    name: user.display_name || user.username,
    preferred_username: user.username,
    email: email?.email,
    email_verified: Boolean(email?.verified),
    roles,
  });
}

async function logout(context, client, req, res) {
  const url = new URL(req.url, context.origin);
  const postLogoutUri = url.searchParams.get('post_logout_redirect_uri');
  const state = url.searchParams.get('state');
  const virtualCallbacks = [
    `${endpointBase(context)}/callback`,
    `${context.origin}/app/${client.client_id}/callback`,
  ];

  if (!postLogoutRedirectAllowed(client, postLogoutUri, virtualCallbacks)) {
    return oidcError(400, 'invalid_request', 'post_logout_redirect_uri is not registered');
  }

  const db = await openRealmDatabase(context.realm);
  const idTokenHint = url.searchParams.get('id_token_hint');
  if (idTokenHint) {
    try {
      await verifyToken(db, idTokenHint, {
        issuer: canonicalIssuer(app.config.server.public_url, context.realm.slug),
        audience: client.client_id,
      });
    } catch {
      return oidcError(400, 'invalid_request', 'id_token_hint is invalid');
    }
  }

  await destroySession(db, requestToken(req, context.realm));
  clearSessionCookie(res, req, context.realm);
  clearAuthRequestCookie(res, req, context.realm);

  if (postLogoutUri) {
    return redirect(res, withQuery(postLogoutUri, { state }));
  }
  return new app.HttpOk({ ok: true });
}

export default {
  mount: '/oidc',
  name: 'oidc',
  async handler(req, res, next) {
    try {
      const context = await resolveOidcContext(req, {
        publicUrl: app.config.server.public_url,
      });
      if (context.action === 'login' || context.action === 'callback') {
        next();
        return;
      }

      const db = await openRealmDatabase(context.realm);
      const client = await getClient(db, context.clientId);
      if (!client || !client.enabled) {
        throw new HttpError(404, 'unknown_client', 'Unknown client');
      }

      let result;
      switch (context.action) {
        case 'openid-configuration':
          result = await discovery(context, client);
          break;
        case 'jwks':
          result = new app.HttpOk(await getJwks(db));
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
