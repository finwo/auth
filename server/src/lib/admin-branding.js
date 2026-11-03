import { HttpError } from './http/http-error.js';

const LOGO_MAX_LENGTH = 2048;
const PRIMARY_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function invalidRequest(message) {
  return new HttpError(400, 'invalid_request', message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseBranding(rawBranding) {
  if (isPlainObject(rawBranding)) return rawBranding;

  try {
    const parsed = JSON.parse(rawBranding || '{}');
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isLoopbackHostname(hostname) {
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '::1'
  );
}

function normalizeStoredPrimaryColor(value) {
  if (typeof value !== 'string') return null;

  const color = value.trim().toLowerCase();
  if (!PRIMARY_COLOR_PATTERN.test(color)) return null;
  if (color.length === 4) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
  }
  return color;
}

function normalizePrimaryColor(value) {
  if (value === null || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'string') {
    throw invalidRequest('primary_color must be a string or null');
  }

  const color = normalizeStoredPrimaryColor(value);
  if (!color) {
    throw invalidRequest('primary_color must be a #rgb or #rrggbb hex color');
  }
  return color;
}

function normalizeLogoUrl(value) {
  if (value === null || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'string') {
    throw invalidRequest('logo_url must be a string or null');
  }

  const url = value.trim();
  if (!url) return null;
  if (url.length > LOGO_MAX_LENGTH) {
    throw invalidRequest(`logo_url must be at most ${LOGO_MAX_LENGTH} characters`);
  }
  if (url.includes('*')) {
    throw invalidRequest('logo_url cannot contain wildcards');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidRequest('logo_url must be an absolute URL');
  }

  const allowedProtocol =
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname));
  if (!allowedProtocol) {
    throw invalidRequest('logo_url must use https, or http for a loopback host');
  }
  if (parsed.username || parsed.password) {
    throw invalidRequest('logo_url cannot contain credentials');
  }
  if (parsed.hash) {
    throw invalidRequest('logo_url cannot contain a fragment');
  }

  return url;
}

export function hasBrandingPatch(body) {
  return (
    isPlainObject(body) &&
    (Object.hasOwn(body, 'logo_url') || Object.hasOwn(body, 'primary_color'))
  );
}

export function normalizeBrandingPatch(body) {
  const input = {};
  if (Object.hasOwn(body, 'logo_url')) {
    input.logo_url = normalizeLogoUrl(body.logo_url);
  }
  if (Object.hasOwn(body, 'primary_color')) {
    input.primary_color = normalizePrimaryColor(body.primary_color);
  }
  return input;
}

export function applyBrandingPatch(rawBranding, patch) {
  if (!hasBrandingPatch(patch)) {
    return typeof rawBranding === 'string' ? rawBranding : JSON.stringify(parseBranding(rawBranding));
  }

  const current = parseBranding(rawBranding);
  const next = { ...current };

  if (Object.hasOwn(patch, 'logo_url')) {
    if (patch.logo_url === null) {
      delete next.logo_url;
    } else {
      next.logo_url = patch.logo_url;
    }
  }

  if (Object.hasOwn(patch, 'primary_color')) {
    if (patch.primary_color === null) {
      delete next.primary_color;
    } else {
      next.primary_color = patch.primary_color;
    }
  }

  return JSON.stringify(next);
}

export function serializeBranding(rawBranding) {
  const branding = parseBranding(rawBranding);
  const logoUrl =
    typeof branding.logo_url === 'string' && branding.logo_url.trim()
      ? branding.logo_url.trim()
      : null;

  return {
    logo_url: logoUrl,
    primary_color: normalizeStoredPrimaryColor(branding.primary_color),
  };
}

export function normalizeBrandingObject(rawBranding) {
  const branding = parseBranding(rawBranding);
  const normalized = { ...branding };

  if (Object.hasOwn(normalized, 'logo_url')) {
    const logoUrl =
      typeof normalized.logo_url === 'string' ? normalized.logo_url.trim() : '';
    if (logoUrl) {
      normalized.logo_url = logoUrl;
    } else {
      delete normalized.logo_url;
    }
  }

  if (Object.hasOwn(normalized, 'primary_color')) {
    const color = normalizeStoredPrimaryColor(normalized.primary_color);
    if (color) {
      normalized.primary_color = color;
    } else {
      delete normalized.primary_color;
    }
  }

  return normalized;
}

export function parseBrandingValue(rawBranding) {
  return parseBranding(rawBranding);
}
