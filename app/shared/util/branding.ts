export const LOGO_MAX_LENGTH = 2048;

export type BrandingField = 'logo_url' | 'primary_color';

export interface BrandingFormValue {
  logo_url: string;
  primary_color: string;
}

export interface BrandingValidationError {
  message: string;
  field: BrandingField;
}

const PRIMARY_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizePreviewColor(value: string): string | null {
  const color = value.trim().toLowerCase();
  if (!PRIMARY_COLOR_PATTERN.test(color)) return null;
  if (color.length === 4) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
  }
  return color;
}

export function isLoopbackHostname(hostname: string): boolean {
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

export function logoUrlError(value: string): string | null {
  const url = value.trim();
  if (!url) return null;
  if (url.length > LOGO_MAX_LENGTH) {
    return `Logo URL must be ${LOGO_MAX_LENGTH} characters or fewer.`;
  }
  if (url.includes('*')) return 'Logo URL cannot contain wildcards.';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Logo URL must be absolute.';
  }

  const allowedProtocol =
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname));
  if (!allowedProtocol) {
    return 'Logo URL must use https, or http for a loopback host.';
  }
  if (parsed.username || parsed.password) return 'Logo URL cannot contain credentials.';
  if (parsed.hash) return 'Logo URL cannot contain a fragment.';

  return null;
}

export function validateBrandingFields(value: BrandingFormValue): BrandingValidationError | null {
  const logoError = logoUrlError(value.logo_url);
  if (logoError) {
    return { message: logoError, field: 'logo_url' };
  }
  if (value.primary_color.trim() && !normalizePreviewColor(value.primary_color)) {
    return {
      message: 'Primary color must be a #rgb or #rrggbb hex color.',
      field: 'primary_color',
    };
  }
  return null;
}

export function brandingFromInput(value: BrandingFormValue) {
  return {
    logo_url: value.logo_url.trim() || null,
    primary_color: value.primary_color.trim() || null,
  };
}

export function brandingValidationErrorField(message: string | null | undefined): BrandingField | null {
  if (!message) return null;
  if (message.includes('logo_url')) return 'logo_url';
  if (message.includes('primary_color')) return 'primary_color';
  return null;
}
