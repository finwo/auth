import { createAppUrls, getAuthUrl as loadAuthUrl } from '@api/config';
import { parseJsonResponse } from '@api/http';
import type { ApiError } from '@api/http';
import { createDiscovery } from '@api/oidc';
import type { Discovery, TokenResponse, UserInfo } from '@api/oidc';

export type { ApiError, Discovery, TokenResponse, UserInfo };

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

export interface ClientConsentInfo {
  client: {
    id: string;
    name: string;
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
  scopes: string[];
  account_url: string;
  active: boolean;
  consent: {
    granted_via: 'user' | 'trusted';
    created_at: number;
    updated_at: number;
    revoked_at: number | null;
  } | null;
}

const urls = createAppUrls('/app/account');
const loadDiscovery = createDiscovery({
  authUrl: () => getAuthUrl(),
  clientId: 'account',
  unavailableMessage: 'Account discovery is unavailable',
  allowMissing: true,
});

export function getBasePath() {
  return urls.basePath;
}

export function appUrl(path = '') {
  return urls.appUrl(path);
}

export function getAuthUrl() {
  return loadAuthUrl(urls.basePath);
}

export function getDiscovery(): Promise<Discovery | null> {
  return loadDiscovery();
}

export async function getClientSession(): Promise<SessionInfo> {
  const response = await fetch('/api/v1/session', {
    credentials: 'same-origin',
  });
  return parseJsonResponse<SessionInfo>(response);
}

async function clientConsentRequest(
  clientId: string,
  method = 'GET'
): Promise<ClientConsentInfo> {
  const response = await fetch(
    `/api/v1/account/clients/${encodeURIComponent(clientId)}/consent`,
    {
      method,
      credentials: 'same-origin',
    }
  );
  return parseJsonResponse<ClientConsentInfo>(response);
}

export function getClientConsent(clientId: string): Promise<ClientConsentInfo> {
  return clientConsentRequest(clientId);
}

export function revokeClientConsent(clientId: string): Promise<ClientConsentInfo> {
  return clientConsentRequest(clientId, 'DELETE');
}

export async function getFullAccountUrl() {
  const authUrl = (await getAuthUrl()).replace(/\/+$/, '');
  return `${authUrl}/app/account`;
}
