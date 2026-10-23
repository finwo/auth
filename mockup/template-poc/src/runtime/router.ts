export function currentRoute() {
  const value = location.hash.replace(/^#/, '');
  return value.startsWith('/') ? value : '/account/overview';
}

export function navigate(path: string) {
  if (!path) return;
  if (currentRoute() === path) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  location.hash = path;
}

export function createRouter(onChange: (path: string) => void) {
  const handler = () => onChange(currentRoute());
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}
