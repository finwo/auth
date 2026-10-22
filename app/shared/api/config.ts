interface AppUrls {
  basePath: string;
  appUrl: (path?: string) => string;
}

const authUrlPromises = new Map<string, Promise<string>>();

export function createAppUrls(appPath: string): AppUrls {
  const current = window.location.pathname;
  const basePath =
    current === appPath || current.startsWith(`${appPath}/`) ? appPath : '';
  return {
    basePath,
    appUrl: (path = '') => `${window.location.origin}${basePath}${path}`,
  };
}

export function getAuthUrl(basePath: string) {
  let promise = authUrlPromises.get(basePath);
  if (!promise) {
    promise = (async () => {
      try {
        const response = await fetch(`${basePath}/config.json`, {
          credentials: 'same-origin',
        });
        if (response.ok) {
          const value = await response.json();
          if (typeof value?.auth_url === 'string' && value.auth_url) {
            return value.auth_url.replace(/\/+$/, '');
          }
        }
      } catch {}
      return window.location.origin;
    })();
    authUrlPromises.set(basePath, promise);
  }
  return promise;
}
