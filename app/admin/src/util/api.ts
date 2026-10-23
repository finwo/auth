import { createAppUrls, getAppConfig } from '@api/config';
import type { ApiError } from '@api/http';
import { createDiscovery } from '@api/oidc';
import type { Discovery, TokenResponse, UserInfo } from '@api/oidc';

export type { ApiError, Discovery, TokenResponse, UserInfo };

export interface AdminRealm {
  slug: string;
  display_name: string;
}

export interface AdminTemplateSource {
  label: string;
  path: string;
  digest: string;
}

export interface AdminPackage {
  id: string;
  type: string;
  name: string;
  version: string;
  author_name: string;
  author_email: string | null;
  digest: string;
  byte_size: number;
  file_count: number;
  filename: string | null;
  created_at: number;
  template_count: number;
  template: AdminTemplateSource | null;
}

export interface AdminTemplateLayer {
  id: string;
  label: string;
  name: string;
  version: string;
  author_name: string;
  author_email: string | null;
  digest: string | null;
  byte_size: number;
  file_count: number;
  filename: string | null;
  created_at: number;
  position: number;
  realm_count: number;
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

export interface AdminConfig {
  auth_url: string;
  openid_configuration: string;
  templateLayers: Array<{ digest: string; url: string }>;
}

let configPromise: Promise<AdminConfig> | null = null;

export function getAdminConfig() {
  if (!configPromise) {
    configPromise = getAppConfig(urls.basePath).then((value) => {
      const authUrl = value.auth_url;
      const openid = value.openid_configuration;
      const templateLayers = value.templateLayers;
      if (typeof authUrl !== 'string' || !authUrl) {
        configPromise = null;
        throw new Error('Admin config is missing auth_url');
      }
      if (typeof openid !== 'string' || !openid) {
        configPromise = null;
        throw new Error('Admin config is missing openid_configuration');
      }
      if (!Array.isArray(templateLayers)) {
        configPromise = null;
        throw new Error('Admin config is missing templateLayers');
      }
      return {
        auth_url: authUrl.replace(/\/+$/, ''),
        openid_configuration: openid,
        templateLayers: templateLayers
          .filter(
            (layer): layer is { digest: string; url: string } =>
              Boolean(
                layer &&
                  typeof layer === 'object' &&
                  typeof (layer as any).digest === 'string' &&
                  typeof (layer as any).url === 'string'
              )
          )
          .map((layer) => ({ digest: layer.digest, url: layer.url })),
      };
    });
  }
  return configPromise;
}

export async function getAuthUrl() {
  return (await getAdminConfig()).auth_url;
}

const loadDiscovery = createDiscovery({
  discoveryUrl: async () => (await getAdminConfig()).openid_configuration,
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
