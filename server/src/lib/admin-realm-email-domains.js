import { HttpError } from './http/http-error.js';
import {
  addRealmEmailDomain,
  findRealmEmailDomainOwner,
  getRealmEmailDomain,
  listRealmEmailDomains,
  markRealmEmailDomainVerified,
  normalizeEmailDomain,
  removeRealmEmailDomain,
  validateRealmEmailDomain,
} from './realm.js';

function invalidRequest(message) {
  return new HttpError(400, 'invalid_request', message);
}

function serialize(row) {
  const verified = Boolean(row.verified);
  return {
    domain: row.domain,
    status: verified ? 'verified' : 'pending',
    verification_token: verified ? null : row.verification_token ?? null,
    verified_at: row.verified_at ?? null,
    created_at: row.created_at,
  };
}

function lookupDomain(domain) {
  try {
    const normalized = normalizeEmailDomain(domain);
    if (!normalized) throw new Error('empty');
    return normalized;
  } catch {
    throw invalidRequest('email domain is required');
  }
}

export async function listAdminRealmEmailDomains({ systemDb, realm }) {
  const rows = await listRealmEmailDomains(systemDb, realm.id);
  return rows.map(serialize);
}

export async function addAdminRealmEmailDomain({
  systemDb,
  realm,
  domain,
  isSystemAdmin = false,
}) {
  const normalized = validateRealmEmailDomain(domain);

  const existing = await findRealmEmailDomainOwner(systemDb, normalized);
  if (existing) {
    if (existing.realm_id === realm.id) {
      throw new HttpError(
        409,
        'domain_in_use',
        'This email domain is already assigned to this realm.'
      );
    }
    throw new HttpError(
      409,
      'domain_in_use',
      isSystemAdmin
        ? `This email domain is already assigned to ${existing.slug}.`
        : 'This email domain is already assigned to another realm.'
    );
  }

  try {
    await addRealmEmailDomain(realm.id, normalized, { verified: false });
  } catch {
    throw new HttpError(409, 'domain_in_use', 'This email domain is already assigned.');
  }

  const row = await getRealmEmailDomain(systemDb, realm.id, normalized);
  if (row) return serialize(row);

  return {
    domain: normalized,
    status: 'pending',
    verification_token: null,
    verified_at: null,
    created_at: Date.now(),
  };
}

export async function verifyAdminRealmEmailDomain({ systemDb, realm, domain }) {
  const normalized = lookupDomain(domain);

  const row = await getRealmEmailDomain(systemDb, realm.id, normalized);
  if (!row) {
    throw new HttpError(404, 'domain_not_found', 'Email domain is not assigned to this realm.');
  }
  if (row.verified) return serialize(row);

  await markRealmEmailDomainVerified(systemDb, realm.id, normalized);
  const updated = await getRealmEmailDomain(systemDb, realm.id, normalized);
  if (updated) return serialize(updated);

  return serialize({ ...row, verified: 1, verification_token: null, verified_at: Date.now() });
}

export async function deleteAdminRealmEmailDomain({ systemDb, realm, domain }) {
  const normalized = lookupDomain(domain);

  const removed = await removeRealmEmailDomain(systemDb, realm.id, normalized);
  if (!removed) {
    throw new HttpError(404, 'domain_not_found', 'Email domain is not assigned to this realm.');
  }

  return { removed: true, domain: normalized };
}
