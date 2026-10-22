import { requestJson } from '@api/http';

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
  realm: string | null;
  display_name: string;
  branding: Record<string, string>;
  access_mode: string;
  system_client: boolean;
  require_pkce: boolean;
  allow_session_duration_choice: boolean;
}

export interface LoginResolution {
  realm: RealmInfo | null;
  next: 'password' | 'oidc';
  provider?: {
    slug: string;
    display_name: string;
  };
}

export interface PasswordLoginResult {
  realm: RealmInfo | null;
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

export interface SessionAccount {
  public_id: string;
  active: boolean;
  user: {
    id: string;
    username: string;
    display_name: string | null;
  };
  created_at: number;
  expires_at: number;
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
  accounts: SessionAccount[];
}

export interface SelectSessionResult {
  ok: boolean;
  user: {
    id: string;
    username: string;
    display_name: string | null;
  };
  expires_at: number;
  pending_auth_request: boolean;
}

export interface ConsentRequest {
  client: {
    id: string;
    name: string;
  };
  realm: RealmInfo | null;
  user: {
    id: string;
    username: string;
    display_name: string | null;
  };
  scopes: string[];
  consent_mode: 'remembered' | 'trusted';
}

export interface ConsentDecision {
  ok: boolean;
  redirect: string;
}

function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  return requestJson<T>(path, options);
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

export function getConsent(clientId?: string | null): Promise<ConsentRequest> {
  const query = clientId ? `?client_id=${encodeURIComponent(clientId)}` : '';
  return request<ConsentRequest>(`/api/v1/consent${query}`);
}

export function decideConsent(
  clientId: string,
  decision: 'allow' | 'deny'
): Promise<ConsentDecision> {
  return request<ConsentDecision>('/api/v1/consent', {
    method: 'POST',
    body: JSON.stringify({ client_id: clientId, decision }),
  });
}

export function selectSession(
  publicId: string,
  clientId?: string | null
): Promise<SelectSessionResult> {
  return request<SelectSessionResult>('/api/v1/session/select', {
    method: 'POST',
    body: JSON.stringify({
      public_id: publicId,
      client_id: clientId || undefined,
    }),
  });
}

export function signOut(): Promise<{ ok: boolean }> {
  return request('/api/v1/logout', { method: 'POST' });
}
