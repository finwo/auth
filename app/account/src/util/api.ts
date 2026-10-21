export interface AccountConfig {
  auth_url: string;
}

export interface Discovery {
  issuer: string;
  client_id: string;
  realm: string | null;
  display_name: string;
  branding: Record<string, string>;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint: string;
  system_client: boolean;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token?: string;
  refresh_token?: string;
  scope: string;
}

export interface UserInfo {
  sub: string;
  name: string;
  preferred_username: string;
  email?: string;
  email_verified: boolean;
  roles: string[];
  is_system_admin: boolean;
}

export interface SessionInfo {
  scope: {
    type: 'global' | 'realm' | 'client';
    host: string;
    realm_id: string | null;
    client_id: string | null;
  };
  realm: {
    slug: string;
    display_name: string;
    branding: Record<string, string>;
  } | null;
  user: {
    id: string;
    username: string;
    display_name: string | null;
  };
  roles: string[];
  is_system_admin: boolean;
  expires_at: number;
  accounts: unknown[];
}

export interface ApiError extends Error {
  code?: string;
  status?: number;
}

let configPromise: Promise<AccountConfig> | null = null;
let discoveryPromise: Promise<Discovery | null> | null = null;

export function getBasePath() {
  const path = window.location.pathname;
  if (path === '/app/account' || path.startsWith('/app/account/')) return '/app/account';
  return '';
}

export function appUrl(path = '') {
  return `${window.location.origin}${getBasePath()}${path}`;
}

async function loadConfig(): Promise<AccountConfig> {
  if (!configPromise) {
    configPromise = (async () => {
      try {
        const response = await fetch(`${getBasePath()}/config.json`, {
          credentials: 'same-origin',
        });
        if (response.ok) {
          const value = await response.json();
          if (typeof value?.auth_url === 'string' && value.auth_url) {
            return { auth_url: value.auth_url.replace(/\/+$/, '') };
          }
        }
      } catch {
        // Server-hosted apps fall back to the current origin.
      }
      return { auth_url: window.location.origin };
    })();
  }
  return configPromise;
}

export async function getAuthUrl() {
  return (await loadConfig()).auth_url;
}

export function getDiscovery(): Promise<Discovery | null> {
  if (!discoveryPromise) {
    discoveryPromise = (async () => {
      const authUrl = await getAuthUrl();
      const response = await fetch(`${authUrl}/oidc/account/openid-configuration`, {
        credentials: 'omit',
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Account discovery is unavailable');
      return response.json();
    })().catch((error) => {
      discoveryPromise = null;
      throw error;
    });
  }
  return discoveryPromise;
}

async function formRequest<T>(url: string, values: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(values).toString(),
  });
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(
      payload?.error_description || payload?.error?.message || response.statusText
    ) as ApiError;
    error.code = payload?.error?.code || payload?.error;
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  verifier: string
): Promise<TokenResponse> {
  const discovery = await getDiscovery();
  if (!discovery) throw new Error('This host does not offer the account client');
  return formRequest<TokenResponse>(discovery.token_endpoint, {
    grant_type: 'authorization_code',
    client_id: 'account',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const discovery = await getDiscovery();
  if (!discovery) throw new Error('This host does not offer the account client');
  return formRequest<TokenResponse>(discovery.token_endpoint, {
    grant_type: 'refresh_token',
    client_id: 'account',
    refresh_token: refreshToken,
  });
}

export async function getUserInfo(accessToken: string): Promise<UserInfo> {
  const discovery = await getDiscovery();
  if (!discovery) throw new Error('This host does not offer the account client');
  const response = await fetch(discovery.userinfo_endpoint, {
    credentials: 'omit',
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(
      payload?.error_description || payload?.error?.message || response.statusText
    ) as ApiError;
    error.code = payload?.error?.code || payload?.error;
    error.status = response.status;
    throw error;
  }
  return payload as UserInfo;
}

export async function getClientSession(): Promise<SessionInfo> {
  const response = await fetch('/api/v1/session', {
    credentials: 'same-origin',
  });
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || response.statusText
    ) as ApiError;
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload as SessionInfo;
}
