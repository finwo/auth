import { createAppUrls, getAuthUrl as loadAuthUrl } from '@api/config';
import type { ApiError } from '@api/http';
import { createDiscovery } from '@api/oidc';
import type { Discovery, TokenResponse, UserInfo } from '@api/oidc';

export type { ApiError, Discovery, TokenResponse, UserInfo };

export interface AdminRealm {
  slug: string;
  display_name: string;
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
  return fetch(`${authUrl}${path}`, {
    ...init,
    credentials: 'omit',
    headers,
  });
}
