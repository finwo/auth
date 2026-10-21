import { HttpError } from '../http/http-error.js';
import { resolveClientForHost, resolveHostContext } from '../host-context.js';

export function requestOrigin(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim();
  const proto = forwarded || (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

export function canonicalBaseUrl(publicUrl) {
  return String(publicUrl || '').replace(/\/+$/, '');
}

export function canonicalIssuer(publicUrl, realmSlug) {
  return `${canonicalBaseUrl(publicUrl)}/oidc/${encodeURIComponent(realmSlug)}`;
}

export function systemIssuer(publicUrl) {
  return canonicalBaseUrl(publicUrl);
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
      systemClient: false,
      action: segments[0],
    };
  }

  if (segments.length !== 2) throw new HttpError(404, 'not_found', 'Not found');
  const clientId = segments[0];
  const action = segments[1];
  const resolved = await resolveClientForHost(hostContext, clientId);

  return {
    mode: hostContext.mode,
    host: hostContext.host,
    origin,
    realm: resolved.realm,
    clientId: resolved.clientId,
    systemClient: resolved.systemClient,
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
