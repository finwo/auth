export function normalizeHostValue(raw: string) {
  return raw.trim().toLowerCase();
}

export function hostFormatError(raw: string): string | null {
  const value = raw.trim();
  const host = normalizeHostValue(value);

  if (!host) return 'Hostname is required.';
  if (/\s/.test(value)) return 'Hostname must not contain spaces.';
  if (host.includes('://') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return 'Hostname must not include a scheme such as https://.';
  }
  if (host.includes('@')) return 'Hostname must not include @.';
  if (host.includes('/')) return 'Hostname must not include a path.';
  if (host.includes('*')) return 'Wildcard hostnames are not supported.';
  if (host.startsWith('[')) {
    if (!host.endsWith(']')) return 'Enter a valid IPv6 hostname.';
  } else if (host.includes(':')) {
    return 'Hostname must not include a port.';
  }
  if (host.length > 253) return 'Hostname must be 253 characters or fewer.';
  if (host.startsWith('.') || host.endsWith('.')) {
    return 'Hostname must not start or end with a dot.';
  }

  if (!host.startsWith('[')) {
    const labels = host.split('.');
    if (labels.length < 2) return 'Enter a complete hostname such as login.acme.test.';
    for (const label of labels) {
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
        return 'Hostname labels must use lowercase letters, numbers and hyphens.';
      }
      if (label.length > 63) return 'Each hostname label must be 63 characters or fewer.';
    }
  }

  return null;
}
