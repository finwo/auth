import {
  adminApi,
  appUrl,
  exchangeCode,
  getDiscovery,
  getUserInfo,
  refreshAccessToken,
  type AdminRealm,
  type AdminSession,
  type ApiError,
  type TokenResponse,
  type UserInfo,
} from './api';

const TOKEN_KEY = 'admin_tokens';
const FLOW_KEY = 'admin_oidc_flow';

export interface AdminTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_at: number;
  scope: string;
}

interface LoginFlow {
  state: string;
  verifier: string;
  redirectUri: string;
}

let refreshPending: Promise<AdminTokens> | null = null;

function base64url(bytes: Uint8Array) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomValue(size = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(size)));
}

async function codeChallenge(verifier: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return base64url(new Uint8Array(digest));
}

function saveTokens(response: TokenResponse): AdminTokens {
  const tokens: AdminTokens = {
    access_token: response.access_token,
    refresh_token: response.refresh_token || '',
    id_token: response.id_token,
    expires_at: Date.now() + response.expires_in * 1000,
    scope: response.scope,
  };
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  return tokens;
}

export function getAdminTokens(): AdminTokens | null {
  try {
    const value = sessionStorage.getItem(TOKEN_KEY);
    return value ? (JSON.parse(value) as AdminTokens) : null;
  } catch {
    return null;
  }
}

export function clearAdminTokens() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(FLOW_KEY);
}

export async function startAdminLogin() {
  const discovery = await getDiscovery();
  const state = randomValue();
  const verifier = randomValue(48);
  const challenge = await codeChallenge(verifier);
  const flow: LoginFlow = {
    state,
    verifier,
    redirectUri: appUrl('/callback'),
  };
  sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow));

  const authorizationUrl = new URL(discovery.authorization_endpoint);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', 'admin');
  authorizationUrl.searchParams.set('redirect_uri', flow.redirectUri);
  authorizationUrl.searchParams.set('scope', 'openid profile email');
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('code_challenge', challenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  window.location.assign(authorizationUrl.toString());
}

export async function completeAdminLogin(search: string) {
  const params = new URLSearchParams(search);
  const error = params.get('error');
  if (error) {
    throw new Error(params.get('error_description') || 'Admin sign-in was denied');
  }

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) throw new Error('The sign-in response is incomplete');

  let flow: LoginFlow | null = null;
  try {
    const value = sessionStorage.getItem(FLOW_KEY);
    flow = value ? (JSON.parse(value) as LoginFlow) : null;
  } catch {
    flow = null;
  }
  if (!flow || flow.state !== state) throw new Error('The sign-in state is invalid');

  const response = await exchangeCode(code, flow.redirectUri, flow.verifier);
  sessionStorage.removeItem(FLOW_KEY);
  saveTokens(response);
}

async function performRefresh(tokens: AdminTokens) {
  if (!tokens.refresh_token) throw new Error('The admin session has expired');
  return saveTokens(await refreshAccessToken(tokens.refresh_token));
}

export function refreshAdminTokens() {
  if (!refreshPending) {
    const tokens = getAdminTokens();
    refreshPending = tokens
      ? performRefresh(tokens)
          .catch((error) => {
            clearAdminTokens();
            throw error;
          })
          .finally(() => {
            refreshPending = null;
          })
      : Promise.reject(new Error('The admin session has expired'));
  }
  return refreshPending;
}

export async function ensureAdminAccessToken() {
  const tokens = getAdminTokens();
  if (!tokens) throw new Error('The admin session has expired');
  if (tokens.expires_at > Date.now() + 30_000) return tokens.access_token;
  return (await refreshAdminTokens()).access_token;
}

async function adminJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let accessToken = await ensureAdminAccessToken();
  let response = await adminApi(path, accessToken, init);
  if (response.status === 401) {
    accessToken = (await refreshAdminTokens()).access_token;
    response = await adminApi(path, accessToken, init);
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(
      payload?.error_description || payload?.error?.message || response.statusText
    ) as ApiError;
    error.code = payload?.error?.code || payload?.error;
    error.status = response.status;
    throw error;
  }
  return payload as T;
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

export async function loadAdminUser(): Promise<UserInfo> {
  let accessToken = await ensureAdminAccessToken();
  try {
    return await getUserInfo(accessToken);
  } catch (error: any) {
    if (error?.status !== 401) throw error;
    accessToken = (await refreshAdminTokens()).access_token;
    return getUserInfo(accessToken);
  }
}

export async function adminSignOut() {
  const tokens = getAdminTokens();
  clearAdminTokens();
  const discovery = await getDiscovery();
  const logoutUrl = new URL(discovery.end_session_endpoint);
  logoutUrl.searchParams.set('post_logout_redirect_uri', appUrl('/'));
  if (tokens?.id_token) logoutUrl.searchParams.set('id_token_hint', tokens.id_token);
  window.location.assign(logoutUrl.toString());
}
