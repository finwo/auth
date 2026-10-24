import { createAppUrls, getAuthUrl as loadAuthUrl } from '@api/config';
import type { ApiError } from '@api/http';
import { createDiscovery } from '@api/oidc';
import type { Discovery, TokenResponse, UserInfo } from '@api/oidc';

export type { ApiError, Discovery, TokenResponse, UserInfo };

export interface AdminRealm {
  slug: string;
  display_name: string;
}

export interface AdminRole {
  slug: string;
  name: string;
}

export interface AdminClient {
  client_id: string;
  name: string;
  logo_url: string | null;
  access_mode: 'internal' | 'members' | 'public';
  enabled: boolean;
  scopes: string;
  required_roles: string[];
  redirect_uris: string[];
  post_logout_redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_basic';
  require_pkce: boolean;
  consent_mode: 'remembered' | 'trusted';
  has_secret: boolean;
  created_at: number;
  updated_at: number;
}

export interface AdminClientInput {
  name: string;
  access_mode: AdminClient['access_mode'];
  enabled: boolean;
  scopes: string;
  required_roles: string[];
  redirect_uris: string[];
  post_logout_redirect_uris: string[];
  token_endpoint_auth_method: AdminClient['token_endpoint_auth_method'];
  require_pkce: boolean;
  consent_mode: AdminClient['consent_mode'];
}

export interface AdminClientCreateInput extends AdminClientInput {
  client_id: string;
}

export interface AdminClientResponse {
  ok: boolean;
  client: AdminClient;
  client_secret?: string;
}

export interface AdminClientSecretResponse {
  ok: boolean;
  client_id: string;
  client: AdminClient;
  client_secret: string;
}

export interface AdminSession {
  public_id: string;
  user: {
    id: string;
    username: string;
    display_name: string;
    home_realm_id: string | null;
    status: string;
  };
  scope: {
    type: string;
    host: string | null;
    client_id: string | null;
  };
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  user_agent: string;
  ip: string;
  revoked_at: number | null;
  revoked_by: string | null;
  can_terminate: boolean;
}

const urls = createAppUrls('/app/admin');

export function getBasePath() {
  return urls.basePath;
}

export function appUrl(path = '') {
  return urls.appUrl(path);
}

export function getAuthUrl() {
  return loadAuthUrl(urls.basePath);
}

const loadDiscovery = createDiscovery({
  authUrl: getAuthUrl,
  clientId: 'admin',
  unavailableMessage: 'Admin discovery is unavailable',
});

export async function getDiscovery(): Promise<Discovery> {
  const discovery = await loadDiscovery();
  if (!discovery) throw new Error('Admin discovery is unavailable');
  return discovery;
}

export async function adminApi(path: string, accessToken: string, init: RequestInit = {}) {
  const authUrl = await getAuthUrl();
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${accessToken}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return fetch(`${authUrl}${path}`, {
    ...init,
    credentials: 'omit',
    headers,
  });
}
