import { HttpError } from './http/http-error.js';
import {
  addRealmHost,
  findOidcClientHost,
  findRealmHost,
  listRealmHosts,
  normalizeHost,
  removeRealmHost,
  validateRealmHostname,
} from './realm.js';

function invalidRequest(message) {
  return new HttpError(400, 'invalid_request', message);
}

export function normalizeReservedHosts(cfg) {
  const sources = [cfg?.server?.public_url, cfg?.apps?.admin, cfg?.apps?.account];
  const reserved = new Set();
  for (const value of sources) {
    if (!value) continue;
    let hostname;
    try {
      hostname = new URL(value).hostname;
    } catch {
      continue;
    }
    const normalized = normalizeHost(hostname);
    if (normalized) reserved.add(normalized);
  }
  return reserved;
}

export async function listAdminRealmHosts({ systemDb, realm }) {
  const rows = await listRealmHosts(systemDb, realm.id);
  return rows.map((row) => ({ host: row.host, created_at: row.created_at }));
}

export async function addAdminRealmHost({
  systemDb,
  realm,
  host,
  isSystemAdmin = false,
  reservedHosts,
}) {
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
    throw new HttpError(
      409,
      'host_in_use',
      isSystemAdmin
        ? 'This hostname is already assigned to a client application.'
        : 'This hostname is already assigned.'
    );
  }

  const existing = await findRealmHost(normalized);
  if (existing) {
    if (existing.id === realm.id) {
      throw new HttpError(409, 'host_in_use', 'This hostname is already assigned to this realm.');
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
    await addRealmHost(realm.id, normalized);
  } catch {
    throw new HttpError(409, 'host_in_use', 'This hostname is already assigned.');
  }

  return { host: normalized, created_at: createdAt };
}

export async function deleteAdminRealmHost({ systemDb, realm, host }) {
  const normalized = normalizeHost(host);
  if (!normalized) throw invalidRequest('host is required');

  const removed = await removeRealmHost(systemDb, realm.id, normalized);
  if (!removed) {
    throw new HttpError(404, 'host_not_found', 'Host is not assigned to this realm.');
  }

  return { removed: true, host: normalized };
}
