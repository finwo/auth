import { HttpError } from './http/http-error.js';

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

export async function resolveLogin(db, identifier) {
  const parsed = normalizeIdentifier(identifier);
  if (!parsed.isEmail) {
    return { next: 'password' };
  }

  const provider = await db.get(
    `SELECT p.slug, p.display_name, p.enabled
       FROM email_domains d
       JOIN identity_providers p ON p.id = d.provider_id
      WHERE d.domain = {domain}
      LIMIT 1`,
    { domain: parsed.domain }
  );

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
