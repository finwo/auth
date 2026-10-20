export interface RealmInfo {
  slug: string;
  display_name: string;
  branding: Record<string, string>;
  allow_session_duration_choice: boolean;
}

export interface ClientDiscovery {
  issuer: string;
  client_id: string;
  client_name: string;
  realm: string;
  display_name: string;
  branding: Record<string, string>;
  access_mode: string;
  virtual: boolean;
  require_pkce: boolean;
  allow_session_duration_choice: boolean;
}

export interface LoginResolution {
  realm: RealmInfo;
  next: 'password' | 'oidc';
  provider?: {
    slug: string;
    display_name: string;
  };
}

export interface PasswordLoginResult {
  realm: RealmInfo;
  user: {
    id: string;
    username: string;
    display_name: string | null;
  };
  expires_at: number;
  pending_auth_request: boolean;
}

export interface SessionScope {
  type: 'global' | 'realm' | 'client';
  host: string;
  realm_id: string | null;
  client_id: string | null;
}

export interface SessionInfo {
  scope: SessionScope;
  realm: RealmInfo | null;
  user: {
    id: string;
    username: string;
    display_name: string | null;
  };
  roles: string[];
  is_system_admin: boolean;
  expires_at: number;
}

export interface ApiError extends Error {
  code?: string;
  status?: number;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
    },
    ...options,
  });

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error?.message || response.statusText) as ApiError;
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }

  return payload as T;
}

export function getRealm(realm?: string | null): Promise<RealmInfo> {
  const query = realm ? `?realm=${encodeURIComponent(realm)}` : '';
  return request<RealmInfo>(`/api/v1/realm${query}`);
}

export function getClientDiscovery(clientId?: string | null): Promise<ClientDiscovery> {
  if (clientId) {
    return request<ClientDiscovery>(`/oidc/${encodeURIComponent(clientId)}/openid-configuration`);
  }
  return request<ClientDiscovery>('/oidc/openid-configuration');
}

export function resolveLogin(
  clientId: string,
  identifier: string
): Promise<LoginResolution> {
  return request<LoginResolution>('/api/v1/login/resolve', {
    method: 'POST',
    body: JSON.stringify({ client_id: clientId, identifier }),
  });
}

export function signInPassword(
  clientId: string,
  identifier: string,
  password: string,
  longSession: boolean
): Promise<PasswordLoginResult> {
  return request<PasswordLoginResult>('/api/v1/login/password', {
    method: 'POST',
    body: JSON.stringify({
      client_id: clientId,
      identifier,
      password,
      long_session: longSession,
    }),
  });
}

export function getSession(): Promise<SessionInfo> {
  return request<SessionInfo>('/api/v1/session');
}

export function signOut(): Promise<{ ok: boolean }> {
  return request('/api/v1/logout', { method: 'POST' });
}
