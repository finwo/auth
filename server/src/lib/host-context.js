import { HttpError } from './http/http-error.js';
import { isVirtualClient } from './oidc/clients.js';
import { findClientRealm, findOidcClientHost, findRealmHost, normalizeHost } from './realm.js';

export async function resolveHostContext(req, { publicUrl } = {}) {
  const host = normalizeHost(req.headers.host);

  const clientHost = await findOidcClientHost(host);
  if (clientHost) {
    return {
      mode: 'client',
      host,
      realm: {
        id: clientHost.realm_id,
        slug: clientHost.slug,
        db_file: clientHost.db_file,
        owner_user_id: clientHost.owner_user_id,
      },
      clientId: clientHost.client_id,
    };
  }

  const realmHost = await findRealmHost(host);
  if (realmHost) {
    return { mode: 'realm', host, realm: realmHost };
  }

  if (publicUrl) {
    const canonicalHost = normalizeHost(new URL(publicUrl).host);
    if (host === canonicalHost) return { mode: 'canonical', host };
  }

  throw new HttpError(404, 'not_found', 'Not found');
}

export async function resolveClientForHost(context, clientId) {
  const value = String(clientId || '').trim();
  if (!value) throw new HttpError(400, 'invalid_request', 'client_id is required');

  if (context.mode === 'client') {
    if (value !== context.clientId) {
      throw new HttpError(404, 'unknown_client', 'Unknown client');
    }
    return { realm: context.realm, clientId: context.clientId };
  }

  if (context.mode === 'realm' && isVirtualClient(value)) {
    return { realm: context.realm, clientId: value };
  }

  const mapping = await findClientRealm(value);
  if (!mapping || !mapping.realm_id) {
    throw new HttpError(404, 'unknown_client', 'Unknown client');
  }
  if (context.mode === 'realm' && mapping.realm_id !== context.realm.id) {
    throw new HttpError(404, 'unknown_client', 'Unknown client');
  }

  return {
    realm: {
      id: mapping.realm_id,
      slug: mapping.slug,
      db_file: mapping.db_file,
      owner_user_id: mapping.owner_user_id,
    },
    clientId: value,
  };
}
