import { HttpError } from '../http/http-error.js';
import { isVirtualClient } from './clients.js';
import {
  findClientRealm,
  findOidcClientHost,
  findRealmHost,
  normalizeHost,
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

export async function resolveOidcContext(req, { publicUrl } = {}) {
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
    const clientId = segments[0];
    if (!isVirtualClient(clientId)) {
      const mapping = await findClientRealm(clientId);
      if (!mapping || mapping.realm_id !== realmHost.id) {
        throw new HttpError(404, 'unknown_client', 'Unknown client');
      }
    }
    return {
      mode: 'realm',
      origin,
      realm: realmHost,
      clientId,
      action: segments[1],
    };
  }

  if (segments.length !== 2) throw new HttpError(404, 'not_found', 'Not found');

  if (publicUrl) {
    const canonicalHost = normalizeHost(new URL(publicUrl).host);
    if (normalizeHost(req.headers.host) !== canonicalHost) {
      throw new HttpError(404, 'not_found', 'Not found');
    }
  }

  const clientId = segments[0];
  const mapping = await findClientRealm(clientId);
  if (!mapping || !mapping.realm_id) {
    throw new HttpError(404, 'unknown_client', 'Unknown client');
  }

  return {
    mode: 'canonical',
    origin,
    realm: {
      id: mapping.realm_id,
      slug: mapping.slug,
      db_file: mapping.db_file,
      owner_user_id: mapping.owner_user_id,
    },
    clientId,
    action: segments[1],
  };
}

export function endpointBase(context) {
  if (context.mode === 'client') return `${context.origin}/oidc`;
  return `${context.origin}/oidc/${encodeURIComponent(context.clientId)}`;
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
