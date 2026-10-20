import { HttpError } from '../http/http-error.js';
import { resolveClientForHost, resolveHostContext } from '../host-context.js';
import { isVirtualClient } from './clients.js';

export function requestOrigin(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim();
  const proto = forwarded || (req.socket?.encrypted ? 'https' : 'http');
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
  const hostContext = await resolveHostContext(req, { publicUrl });

  if (hostContext.mode === 'client') {
    if (segments.length !== 1) throw new HttpError(404, 'not_found', 'Not found');
    return {
      mode: 'client',
      host: hostContext.host,
      origin,
      realm: hostContext.realm,
      clientId: hostContext.clientId,
      action: segments[0],
    };
  }

  if (segments.length !== 2) throw new HttpError(404, 'not_found', 'Not found');
  const clientId = segments[0];
  const action = segments[1];

  if (hostContext.mode === 'realm') {
    const resolved = isVirtualClient(clientId)
      ? { realm: hostContext.realm, clientId }
      : await resolveClientForHost(hostContext, clientId);
    return {
      mode: 'realm',
      host: hostContext.host,
      origin,
      realm: resolved.realm,
      clientId: resolved.clientId,
      action,
    };
  }

  const resolved = await resolveClientForHost(hostContext, clientId);
  return {
    mode: 'canonical',
    host: hostContext.host,
    origin,
    realm: resolved.realm,
    clientId: resolved.clientId,
    action,
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
