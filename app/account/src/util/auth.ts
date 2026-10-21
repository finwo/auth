import {
  appUrl,
  exchangeCode,
  getDiscovery,
  getUserInfo,
  refreshAccessToken,
  type TokenResponse,
  type UserInfo,
} from './api';

const TOKEN_KEY = 'account_tokens';
const FLOW_KEY = 'account_oidc_flow';

export interface AccountTokens {
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

let refreshPending: Promise<AccountTokens> | null = null;

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

function saveTokens(response: TokenResponse): AccountTokens {
  const tokens: AccountTokens = {
    access_token: response.access_token,
    refresh_token: response.refresh_token || '',
    id_token: response.id_token,
    expires_at: Date.now() + response.expires_in * 1000,
    scope: response.scope,
  };
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  return tokens;
}

export function getAccountTokens(): AccountTokens | null {
  try {
    const value = sessionStorage.getItem(TOKEN_KEY);
    return value ? (JSON.parse(value) as AccountTokens) : null;
  } catch {
    return null;
  }
}

export function clearAccountTokens() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(FLOW_KEY);
}

export async function startAccountLogin() {
  const discovery = await getDiscovery();
  if (!discovery) throw new Error('This host does not offer the account client');
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
  authorizationUrl.searchParams.set('client_id', 'account');
  authorizationUrl.searchParams.set('redirect_uri', flow.redirectUri);
  authorizationUrl.searchParams.set('scope', 'openid profile email');
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('code_challenge', challenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  window.location.assign(authorizationUrl.toString());
}

export async function completeAccountLogin(search: string) {
  const params = new URLSearchParams(search);
  const error = params.get('error');
  if (error) {
    throw new Error(params.get('error_description') || 'Account sign-in was denied');
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

async function performRefresh(tokens: AccountTokens) {
  if (!tokens.refresh_token) throw new Error('The account session has expired');
  return saveTokens(await refreshAccessToken(tokens.refresh_token));
}

export function refreshAccountTokens() {
  if (!refreshPending) {
    const tokens = getAccountTokens();
    refreshPending = tokens
      ? performRefresh(tokens)
          .catch((error) => {
            clearAccountTokens();
            throw error;
          })
          .finally(() => {
            refreshPending = null;
          })
      : Promise.reject(new Error('The account session has expired'));
  }
  return refreshPending;
}

export async function ensureAccountAccessToken() {
  const tokens = getAccountTokens();
  if (!tokens) throw new Error('The account session has expired');
  if (tokens.expires_at > Date.now() + 30_000) return tokens.access_token;
  return (await refreshAccountTokens()).access_token;
}

export async function loadAccountUser(): Promise<UserInfo> {
  let accessToken = await ensureAccountAccessToken();
  try {
    return await getUserInfo(accessToken);
  } catch (error: any) {
    if (error?.status !== 401) throw error;
    accessToken = (await refreshAccountTokens()).access_token;
    return getUserInfo(accessToken);
  }
}

export async function accountSignOut() {
  const tokens = getAccountTokens();
  clearAccountTokens();
  const discovery = await getDiscovery();
  if (!discovery) throw new Error('This host does not offer the account client');
  const logoutUrl = new URL(discovery.end_session_endpoint);
  logoutUrl.searchParams.set('post_logout_redirect_uri', appUrl('/'));
  if (tokens?.id_token) logoutUrl.searchParams.set('id_token_hint', tokens.id_token);
  window.location.assign(logoutUrl.toString());
}
