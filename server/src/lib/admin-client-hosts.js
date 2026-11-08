import { HttpError } from './http/http-error.js';
import {
  addOidcClientHost,
  findClientRealm,
  findOidcClientHost,
  findRealmHost,
  listOidcClientHosts,
  normalizeHost,
  removeOidcClientHost,
  validateRealmHostname,
} from './realm.js';
import { isSystemClient } from './oidc/clients.js';
import { normalizeReservedHosts } from './admin-realm-hosts.js';
import { destroyClientHostSessions } from './session.js';

function invalidRequest(message) {
  return new HttpError(400, 'invalid_request', message);
}

async function assertClientUsable(clientId, realm) {
  if (isSystemClient(clientId)) {
    throw new HttpError(400, 'reserved_client_id', 'This client_id is reserved');
  }
  const mapping = await findClientRealm(clientId);
  if (!mapping || mapping.realm_id !== realm.id) {
    throw new HttpError(404, 'client_not_found', 'Client is not available in this realm.');
  }
}

export async function listAdminClientHosts({ systemDb, realm, clientId }) {
  await assertClientUsable(clientId, realm);
  const rows = await listOidcClientHosts(systemDb, clientId);
  return rows.map((row) => ({ host: row.host, created_at: row.created_at }));
}

export async function addAdminClientHost({
  systemDb,
  realm,
  clientId,
  host,
  isSystemAdmin = false,
  reservedHosts,
}) {
  await assertClientUsable(clientId, realm);
  const normalized = validateRealmHostname(host);

  if (reservedHosts && reservedHosts.has(normalized)) {
    throw new HttpError(
      409,
      'host_reserved',
      'This hostname is reserved for the authentication service.'
    );
  }

  const clientHost = await findOidcClientHost(normalized);
  if (clientHost) {
    if (clientHost.client_id === clientId) {
      throw new HttpError(
        409,
        'host_in_use',
        'This hostname is already assigned to this client.'
      );
    }
    throw new HttpError(
      409,
      'host_in_use',
      'This hostname is already assigned to a client application.'
    );
  }

  const existing = await findRealmHost(normalized);
  if (existing) {
    if (existing.id === realm.id) {
      throw new HttpError(
        409,
        'host_in_use',
        'This hostname is already assigned to this realm.'
      );
    }
    throw new HttpError(
      409,
      'host_in_use',
      isSystemAdmin
        ? `This hostname is already assigned to ${existing.slug}.`
        : 'This hostname is already assigned to another realm.'
    );
  }

  const createdAt = Date.now();
  try {
    await addOidcClientHost(clientId, normalized);
  } catch {
    throw new HttpError(409, 'host_in_use', 'This hostname is already assigned.');
  }

  return { host: normalized, created_at: createdAt };
}

export async function deleteAdminClientHost({ systemDb, realm, clientId, host }) {
  await assertClientUsable(clientId, realm);
  const normalized = normalizeHost(host);
  if (!normalized) throw invalidRequest('host is required');

  const removed = await removeOidcClientHost(systemDb, clientId, normalized);
  if (!removed) {
    throw new HttpError(404, 'host_not_found', 'Host is not assigned to this client.');
  }

  await destroyClientHostSessions(systemDb, {
    realmId: realm.id,
    clientId,
    host: normalized,
  });

  return { removed: true, host: normalized };
}
