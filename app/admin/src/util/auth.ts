import { parseJsonResponse } from '@api/http';
import { createOidcAuth, type StoredTokens } from '@api/oidc';
import {
  adminApi,
  appUrl,
  getDiscovery,
  type AdminClient,
  type AdminClientCreateInput,
  type AdminClientInput,
  type AdminClientResponse,
  type AdminClientSecretResponse,
  type AdminGlobalUser,
  type AdminGlobalUserDetail,
  type AdminMeUser,
  type AdminRealm,
  type AdminRealmUser,
  type AdminRole,
  type AdminSession,
  type AdminUserBan,
  type AdminUserDetail,
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

export async function loadAdminMe(): Promise<AdminMeUser> {
  const response = await adminJson<{ user: AdminMeUser }>('/api/v1/admin/me');
  return response.user;
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

export async function loadAdminRoles(realmSlug: string): Promise<AdminRole[]> {
  const realm = encodeURIComponent(realmSlug);
  const response = await adminJson<{ roles: AdminRole[] }>(
    `/api/v1/admin/realms/${realm}/roles`
  );
  return response.roles;
}

export async function loadAdminClients(realmSlug: string): Promise<AdminClient[]> {
  const realm = encodeURIComponent(realmSlug);
  const response = await adminJson<{ clients: AdminClient[] }>(
    `/api/v1/admin/realms/${realm}/clients`
  );
  return response.clients;
}

export async function createAdminClient(
  realmSlug: string,
  input: AdminClientCreateInput
): Promise<AdminClientResponse> {
  const realm = encodeURIComponent(realmSlug);
  return adminJson<AdminClientResponse>(`/api/v1/admin/realms/${realm}/clients`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateAdminClient(
  realmSlug: string,
  clientId: string,
  input: AdminClientInput
): Promise<AdminClientResponse> {
  const realm = encodeURIComponent(realmSlug);
  const client = encodeURIComponent(clientId);
  return adminJson<AdminClientResponse>(
    `/api/v1/admin/realms/${realm}/clients/${client}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    }
  );
}

export async function deleteAdminClient(realmSlug: string, clientId: string) {
  const realm = encodeURIComponent(realmSlug);
  const client = encodeURIComponent(clientId);
  return adminJson(`/api/v1/admin/realms/${realm}/clients/${client}`, {
    method: 'DELETE',
  });
}

export async function rotateAdminClientSecret(
  realmSlug: string,
  clientId: string
): Promise<AdminClientSecretResponse> {
  const realm = encodeURIComponent(realmSlug);
  const client = encodeURIComponent(clientId);
  return adminJson<AdminClientSecretResponse>(
    `/api/v1/admin/realms/${realm}/clients/${client}/secret`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );
}

export async function loadAdminUsers(realmSlug: string): Promise<AdminRealmUser[]> {
  const realm = encodeURIComponent(realmSlug);
  const response = await adminJson<{ users: AdminRealmUser[] }>(
    `/api/v1/admin/realms/${realm}/users`
  );
  return response.users;
}

export async function loadAdminGlobalUsers(): Promise<AdminGlobalUser[]> {
  const response = await adminJson<{ users: AdminGlobalUser[] }>('/api/v1/admin/users');
  return response.users;
}

export async function loadAdminGlobalUser(userId: string): Promise<AdminGlobalUserDetail> {
  const user = encodeURIComponent(userId);
  return adminJson<AdminGlobalUserDetail>(`/api/v1/admin/users/${user}`);
}

export async function loadAdminUserDetail(
  realmSlug: string,
  userId: string
): Promise<AdminUserDetail> {
  const realm = encodeURIComponent(realmSlug);
  const user = encodeURIComponent(userId);
  return adminJson<AdminUserDetail>(`/api/v1/admin/realms/${realm}/users/${user}`);
}

export async function revokeAdminUserConsent(
  realmSlug: string,
  userId: string,
  clientId: string
) {
  const realm = encodeURIComponent(realmSlug);
  const user = encodeURIComponent(userId);
  const client = encodeURIComponent(clientId);
  return adminJson(`/api/v1/admin/realms/${realm}/users/${user}/consents/${client}`, {
    method: 'DELETE',
  });
}

export async function createAdminUserBan(
  realmSlug: string,
  userId: string,
  clientId: string
): Promise<{ ok: boolean; ban: AdminUserBan }> {
  const realm = encodeURIComponent(realmSlug);
  const user = encodeURIComponent(userId);
  return adminJson<{ ok: boolean; ban: AdminUserBan }>(
    `/api/v1/admin/realms/${realm}/users/${user}/bans`,
    {
      method: 'POST',
      body: JSON.stringify({ client_id: clientId }),
    }
  );
}

export async function deleteAdminUserBan(
  realmSlug: string,
  userId: string,
  clientId: string
) {
  const realm = encodeURIComponent(realmSlug);
  const user = encodeURIComponent(userId);
  const client = encodeURIComponent(clientId);
  return adminJson(`/api/v1/admin/realms/${realm}/users/${user}/bans/${client}`, {
    method: 'DELETE',
  });
}
