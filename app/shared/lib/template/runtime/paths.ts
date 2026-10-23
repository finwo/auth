export function normalizePath(value: string): string {
  const input = String(value || '').replace(/\\/g, '/');
  if (!input || input.includes('\0') || input.startsWith('/')) {
    throw new Error(`Invalid template path: ${value}`);
  }

  const parts: string[] = [];
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`Invalid template path: ${value}`);
    parts.push(part);
  }

  if (parts.length === 0) throw new Error(`Invalid template path: ${value}`);
  return parts.join('/');
}

export function resolvePath(baseFile: string, reference: string): string {
  const value = String(reference || '').trim();
  if (!value) throw new Error('Empty template reference');
  if (value.startsWith('/')) throw new Error(`Invalid template reference: ${reference}`);

  const base = baseFile.split('/');
  base.pop();
  return normalizePath([...base, value].join('/'));
}

export function templateReference(value: string): string | null {
  const prefix = 'template://';
  if (!value.startsWith(prefix)) return null;
  return normalizePath(decodeURIComponent(value.slice(prefix.length)));
}

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}
