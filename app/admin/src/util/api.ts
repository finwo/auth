import { createAppUrls, getAuthUrl as loadAuthUrl } from '@api/config';
import type { ApiError } from '@api/http';
import { createDiscovery } from '@api/oidc';
import type { Discovery, TokenResponse, UserInfo } from '@api/oidc';

export type { ApiError, Discovery, TokenResponse, UserInfo };

export interface AdminRealmOwner {
  id: string;
  username: string | null;
  display_name: string | null;
  email: string | null;
}

export interface AdminRealm {
  slug: string;
  display_name: string;
  owner: AdminRealmOwner | null;
  host_count: number;
  email_domain_count: number;
  client_count: number;
  member_count: number;
  created_at: number;
  updated_at: number;
  can_edit: boolean;
  can_delete: boolean;
}

export interface AdminRealmCreateInput {
  slug: string;
  display_name: string;
  logo_url?: string | null;
  primary_color?: string | null;
}

export interface AdminRealmCreateResponse {
  ok: boolean;
  realm: AdminRealm;
}

export interface AdminRealmDeleteResponse {
  ok: boolean;
  removed: boolean;
}

export interface AdminRealmHost {
  host: string;
  created_at: number;
}

export interface AdminRealmHostListResponse {
  hosts: AdminRealmHost[];
}

export interface AdminRealmHostCreateResponse {
  ok: boolean;
  host: AdminRealmHost;
}

export interface AdminRealmHostDeleteResponse {
  ok: boolean;
  removed: boolean;
  host: string;
}

export interface AdminRealmSettings {
  slug: string;
  display_name: string;
  allow_session_duration_choice: boolean;
  logo_url: string | null;
  primary_color: string | null;
  created_at: number;
  updated_at: number;
}

export interface AdminRealmSettingsInput {
  display_name: string;
  allow_session_duration_choice: boolean;
  logo_url?: string | null;
  primary_color?: string | null;
}

export interface AdminSystemSettings {
  logo_url: string | null;
  primary_color: string | null;
  updated_at: number;
}

export interface AdminSystemSettingsInput {
  logo_url?: string | null;
  primary_color?: string | null;
}

export interface AdminRole {
  slug: string;
  name: string;
}

export interface AdminClient {
  client_id: string;
  name: string;
  logo_url: string | null;
  primary_color: string | null;
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
  logo_url?: string | null;
  primary_color?: string | null;
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

export interface AdminRealmUser {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  status: string;
  membership_status: string | null;
  relationship: 'home' | 'guest';
  roles: string[];
  is_system_admin: boolean;
  banned: boolean;
  ban_count: number;
  last_login_at: number | null;
  created_at: number;
}

export interface AdminUserConsent {
  client_id: string;
  client_name: string | null;
  client_consent_mode: string | null;
  scopes: string[];
  granted_via: 'user' | 'trusted' | string;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  active: boolean;
}

export interface AdminUserBan {
  client_id: string;
  client_name: string | null;
  created_by: string | null;
  created_by_username: string | null;
  created_at: number;
}

export interface AdminUserPermissions {
  is_self: boolean;
  can_manage_membership: boolean;
  can_suspend_membership: boolean;
  can_reactivate_membership: boolean;
  can_edit_roles: boolean;
  can_remove_last_realm_admin: boolean;
  last_active_realm_admin: boolean;
  reason: string | null;
}

export interface AdminUserDetail {
  user: {
    id: string;
    username: string;
    display_name: string;
    email: string | null;
    status: string;
    membership_status: string | null;
    relationship: 'home' | 'guest';
    roles: string[];
    is_system_admin: boolean;
    banned: boolean;
    ban_count: number;
    home_realm_id: string | null;
    last_login_at: number | null;
    created_at: number;
    updated_at: number;
  };
  consents: AdminUserConsent[];
  bans: AdminUserBan[];
  permissions: AdminUserPermissions;
}

export interface AdminUserMutationResponse extends AdminUserDetail {
  ok: boolean;
}

export interface AdminUserLookup {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  status: string;
  is_system_admin: boolean;
  home_realm_slug: string | null;
  relationship: 'home' | 'guest' | 'none';
  membership_status: string | null;
  roles: string[];
  can_add: boolean;
  reason: string | null;
}

export interface AdminRealmAccessRevoked {
  consents: number;
  refresh_tokens: number;
  session_realms: number;
}

export interface AdminUserMembershipUpdateResponse extends AdminUserMutationResponse {
  revoked: AdminRealmAccessRevoked;
}

export interface AdminMeUser {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  is_system_admin: boolean;
  home_realm_slug: string | null;
  can_create_realm: boolean;
}

export interface AdminGlobalUser {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  status: string;
  is_system_admin: boolean;
  home_realm_slug: string | null;
  membership_count: number;
  last_login_at: number | null;
  created_at: number;
}

export interface AdminGlobalUserMembership {
  slug: string;
  display_name: string;
  relationship: 'home' | 'guest';
  membership_status: string;
  roles: string[];
  banned: boolean;
}

export interface AdminGlobalUserDetail {
  user: {
    id: string;
    username: string;
    display_name: string;
    email: string | null;
    status: string;
    is_system_admin: boolean;
    home_realm_slug: string | null;
    last_login_at: number | null;
    created_at: number;
    updated_at: number;
  };
  memberships: AdminGlobalUserMembership[];
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
