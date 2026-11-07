export function formatTime(value: number | null | undefined) {
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function scopeLabel(type: string) {
  if (type === 'global') return 'Canonical session';
  if (type === 'realm') return 'Realm session';
  if (type === 'client') return 'Client session';
  return type;
}
