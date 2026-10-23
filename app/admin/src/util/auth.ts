import { parseJsonResponse } from '@api/http';
import { createOidcAuth, type StoredTokens } from '@api/oidc';
import {
  adminApi,
  appUrl,
  getDiscovery,
  type AdminPackage,
  type AdminRealm,
  type AdminSession,
  type AdminTemplateLayer,
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

export interface AdminTemplateUpload {
  file: File;
  name?: string;
  version?: string;
  authorName?: string;
  authorEmail?: string;
}

function fileForm(file: File) {
  const form = new FormData();
  form.append('file', file, file.name);
  return form;
}

export async function loadAdminPackages(): Promise<AdminPackage[]> {
  const response = await adminJson<{ packages: AdminPackage[] }>('/api/v1/admin/packages');
  return response.packages;
}

export async function uploadAdminPackage(file: File): Promise<AdminPackage> {
  const response = await adminJson<{ package: AdminPackage }>('/api/v1/admin/packages', {
    method: 'POST',
    body: fileForm(file),
  });
  return response.package;
}

export async function deleteAdminPackage(id: string) {
  await adminJson(`/api/v1/admin/packages/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function loadAdminTemplates(): Promise<AdminPackage[]> {
  const response = await adminJson<{ templates: AdminPackage[] }>('/api/v1/admin/templates');
  return response.templates;
}

export async function uploadAdminTemplate(upload: AdminTemplateUpload): Promise<AdminPackage> {
  const form = fileForm(upload.file);
  const values: Array<[string, string | undefined]> = [
    ['name', upload.name],
    ['version', upload.version],
    ['author_name', upload.authorName],
    ['author_email', upload.authorEmail],
  ];
  for (const [name, value] of values) {
    if (value && value.trim()) form.append(name, value.trim());
  }

  const response = await adminJson<{ template: AdminPackage }>('/api/v1/admin/templates', {
    method: 'POST',
    body: form,
  });
  return response.template;
}

export async function deleteAdminTemplate(id: string) {
  await adminJson(`/api/v1/admin/templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function loadAdminRealmTemplates(realmSlug: string): Promise<AdminTemplateLayer[]> {
  const realm = encodeURIComponent(realmSlug);
  const response = await adminJson<{ layers: AdminTemplateLayer[] }>(
    `/api/v1/admin/realms/${realm}/templates`
  );
  return response.layers;
}

export async function replaceAdminRealmTemplates(
  realmSlug: string,
  packageIds: string[]
): Promise<AdminTemplateLayer[]> {
  const realm = encodeURIComponent(realmSlug);
  const response = await adminJson<{ layers: AdminTemplateLayer[] }>(
    `/api/v1/admin/realms/${realm}/templates`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package_ids: packageIds }),
    }
  );
  return response.layers;
}

export async function loadAdminSystemTemplates(): Promise<AdminTemplateLayer[]> {
  const response = await adminJson<{ layers: AdminTemplateLayer[] }>(
    '/api/v1/admin/system/templates'
  );
  return response.layers;
}

export async function replaceAdminSystemTemplates(
  packageIds: string[]
): Promise<AdminTemplateLayer[]> {
  const response = await adminJson<{ layers: AdminTemplateLayer[] }>(
    '/api/v1/admin/system/templates',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package_ids: packageIds }),
    }
  );
  return response.layers;
}
