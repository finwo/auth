import { parseJsonResponse } from '@api/http';
import { createOidcAuth, type StoredTokens } from '@api/oidc';
import {
  adminApi,
  appUrl,
  getDiscovery,
  type AdminRealm,
  type AdminSession,
} from './api';

export type AdminTokens = StoredTokens;

const auth = createOidcAuth({
  clientId: 'admin',
  tokenKey: 'admin_tokens',
  flowKey: 'admin_oidc_flow',
  discovery: getDiscovery,
  appUrl,
  deniedMessage: 'Admin sign-in was denied',
  expiredMessage: 'The admin session has expired',
  unavailableMessage: 'Admin discovery is unavailable',
});

export const getAdminTokens = auth.getTokens;
export const clearAdminTokens = auth.clearTokens;
export const startAdminLogin = auth.startLogin;
export const completeAdminLogin = auth.completeLogin;
export const refreshAdminTokens = auth.refreshTokens;
export const ensureAdminAccessToken = auth.ensureAccessToken;
export const loadAdminUser = auth.loadUser;
export const adminSignOut = auth.signOut;

async function adminJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let accessToken = await ensureAdminAccessToken();
  let response = await adminApi(path, accessToken, init);
  if (response.status === 401) {
    accessToken = (await refreshAdminTokens()).access_token;
    response = await adminApi(path, accessToken, init);
  }
  return parseJsonResponse<T>(response);
}

export async function loadAdminRealms(): Promise<AdminRealm[]> {
  const response = await adminJson<{ realms: AdminRealm[] }>('/api/v1/admin/realms');
  return response.realms;
}

export async function loadAdminSessions(realmSlug: string): Promise<AdminSession[]> {
  const realm = encodeURIComponent(realmSlug);
  const response = await adminJson<{ sessions: AdminSession[] }>(
    `/api/v1/admin/realms/${realm}/sessions`
  );
  return response.sessions;
}

export async function revokeAdminSessionRealm(realmSlug: string, publicId: string) {
  const realm = encodeURIComponent(realmSlug);
  const session = encodeURIComponent(publicId);
  await adminJson(`/api/v1/admin/realms/${realm}/sessions/${session}/realm`, {
    method: 'DELETE',
  });
}

export async function terminateAdminSession(realmSlug: string, publicId: string) {
  const realm = encodeURIComponent(realmSlug);
  const session = encodeURIComponent(publicId);
  await adminJson(`/api/v1/admin/realms/${realm}/sessions/${session}`, {
    method: 'DELETE',
  });
}
