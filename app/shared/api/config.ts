interface AppUrls {
  basePath: string;
  appUrl: (path?: string) => string;
}

const configPromises = new Map<string, Promise<Record<string, unknown>>>();
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

export function getAppConfig(basePath: string): Promise<Record<string, unknown>> {
  let promise = configPromises.get(basePath);
  if (!promise) {
    promise = (async () => {
      try {
        const response = await fetch(`${basePath}/config.json`, {
          credentials: 'same-origin',
        });
        if (response.ok) {
          const value = await response.json();
          if (value && typeof value === 'object') {
            return value as Record<string, unknown>;
          }
        }
      } catch {}
      return {};
    })();
    configPromises.set(basePath, promise);
  }
  return promise;
}

export function getAuthUrl(basePath: string) {
  let promise = authUrlPromises.get(basePath);
  if (!promise) {
    promise = getAppConfig(basePath).then((value) => {
      if (typeof value.auth_url === 'string' && value.auth_url) {
        return value.auth_url.replace(/\/+$/, '');
      }
      return window.location.origin;
    });
    authUrlPromises.set(basePath, promise);
  }
  return promise;
}
