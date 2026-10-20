import { HttpError } from './http/http-error.js';
import { findRealmByEmailDomain, openRealmDatabase } from './realm.js';
import { getUserEmails, emailDomain } from './users.js';

export function normalizeIdentifier(identifier) {
  const value = String(identifier || '').trim();
  if (!value) {
    throw new HttpError(400, 'invalid_request', 'An email address or username is required');
  }
  if (value.length > 254) {
    throw new HttpError(400, 'invalid_request', 'The identifier is too long');
  }

  const at = value.lastIndexOf('@');
  const isEmail = at > 0 && at < value.length - 1;
  const normalized = value.toLowerCase();

  return {
    value,
    normalized,
    isEmail,
    domain: isEmail ? normalized.slice(at + 1) : null,
  };
}

export async function getProviderForDomain(realm, domain) {
  const db = await openRealmDatabase(realm);
  return db.get(
    `SELECT p.slug, p.display_name, p.enabled
       FROM email_domain_providers d
       JOIN identity_providers p ON p.id = d.provider_id
      WHERE d.domain = {domain}
      LIMIT 1`,
    { domain }
  );
}

export async function resolveLogin({ identifier }) {
  const parsed = normalizeIdentifier(identifier);
  if (!parsed.isEmail) {
    return { next: 'password' };
  }

  const owner = await findRealmByEmailDomain(parsed.domain);
  if (!owner) {
    return { next: 'password' };
  }

  const provider = await getProviderForDomain(owner, parsed.domain);
  if (!provider) {
    return { next: 'password' };
  }

  if (!provider.enabled) {
    throw new HttpError(409, 'provider_disabled', 'The identity provider for this domain is unavailable');
  }

  return {
    next: 'oidc',
    provider: {
      slug: provider.slug,
      display_name: provider.display_name,
    },
  };
}

export async function findManagedProviderForUser(systemDb, user) {
  if (!user || !user.home_realm_id) return null;

  const homeRealm = await systemDb.get(
    'SELECT id, slug, db_file, owner_user_id FROM realms WHERE id = {id}',
    { id: user.home_realm_id }
  );
  if (!homeRealm) return null;

  const emails = await getUserEmails(systemDb, user.id);
  for (const entry of emails) {
    if (!entry.verified) continue;
    const domain = emailDomain(entry.email);
    if (!domain) continue;

    const owned = await systemDb.get(
      `SELECT domain
         FROM realm_email_domains
        WHERE domain = {domain} AND realm_id = {realmId} AND verified = 1`,
      { domain, realmId: homeRealm.id }
    );
    if (!owned) continue;

    const provider = await getProviderForDomain(homeRealm, domain);
    if (provider) return provider;
  }

  return null;
}
