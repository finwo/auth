import { HttpError } from '../http/http-error.js';
import {
  findOidcClientHost,
  findRealmBySlug,
  findRealmHost,
} from '../realm.js';

export function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase() || (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

export function canonicalIssuer(publicUrl, realmSlug) {
  const base = String(publicUrl || '').replace(/\/+$/, '');
  return `${base}/oidc/${encodeURIComponent(realmSlug)}`;
}

function pathSegments(req) {
  const pathname = String(req.url || '/').split('?')[0];
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

export async function resolveOidcContext(req) {
  const segments = pathSegments(req);
  const origin = requestOrigin(req);

  const clientHost = await findOidcClientHost(req.headers.host);
  if (clientHost) {
    if (segments.length !== 1) throw new HttpError(404, 'not_found', 'Not found');
    return {
      mode: 'client',
      origin,
      realm: {
        id: clientHost.realm_id,
        slug: clientHost.slug,
        db_file: clientHost.db_file,
        owner_user_id: clientHost.owner_user_id,
      },
      clientId: clientHost.client_id,
      action: segments[0],
    };
  }

  const realmHost = await findRealmHost(req.headers.host);
  if (realmHost) {
    if (segments.length !== 2) throw new HttpError(404, 'not_found', 'Not found');
    return {
      mode: 'realm',
      origin,
      realm: realmHost,
      clientId: segments[0],
      action: segments[1],
    };
  }

  if (segments.length !== 3) throw new HttpError(404, 'not_found', 'Not found');
  const realm = await findRealmBySlug(segments[0]);
  if (!realm) throw new HttpError(404, 'unknown_realm', 'Unknown realm');

  return {
    mode: 'canonical',
    origin,
    realm,
    clientId: segments[1],
    action: segments[2],
  };
}

export function endpointBase(context) {
  if (context.mode === 'client') return `${context.origin}/oidc`;
  if (context.mode === 'realm') return `${context.origin}/oidc/${encodeURIComponent(context.clientId)}`;
  return `${context.origin}/oidc/${encodeURIComponent(context.realm.slug)}/${encodeURIComponent(
    context.clientId
  )}`;
}

export function endpointUrls(context) {
  const base = endpointBase(context);
  return {
    openid_configuration: `${base}/openid-configuration`,
    login: `${base}/login`,
    authorize: `${base}/authorize`,
    token: `${base}/token`,
    userinfo: `${base}/userinfo`,
    jwks: `${base}/jwks`,
    logout: `${base}/logout`,
  };
}
