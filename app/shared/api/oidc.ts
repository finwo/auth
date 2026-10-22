import { formRequest, parseJsonResponse, type ApiError } from '@api/http';

export interface Discovery {
  issuer: string;
  client_id: string;
  realm: string | null;
  display_name: string;
  branding: Record<string, string>;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint: string;
  system_client: boolean;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token?: string;
  refresh_token?: string;
  scope: string;
}

export interface UserInfo {
  sub: string;
  name: string;
  preferred_username: string;
  email?: string;
  email_verified: boolean;
  roles: string[];
  is_system_admin: boolean;
}

export interface StoredTokens {
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

interface DiscoveryOptions {
  authUrl: () => Promise<string>;
  clientId: string;
  unavailableMessage: string;
  allowMissing?: boolean;
}

export function createDiscovery(options: DiscoveryOptions) {
  let discoveryPromise: Promise<Discovery | null> | null = null;
  return function getDiscovery(): Promise<Discovery | null> {
    if (!discoveryPromise) {
      discoveryPromise = (async () => {
        const authUrl = await options.authUrl();
        const response = await fetch(
          `${authUrl}/oidc/${encodeURIComponent(options.clientId)}/openid-configuration`,
          { credentials: 'omit' }
        );
        if (options.allowMissing && response.status === 404) return null;
        if (!response.ok) throw new Error(options.unavailableMessage);
        return parseJsonResponse<Discovery>(response);
      })().catch((error) => {
        discoveryPromise = null;
        throw error;
      });
    }
    return discoveryPromise;
  };
}

export interface OidcAuthOptions {
  clientId: string;
  tokenKey: string;
  flowKey: string;
  discovery: () => Promise<Discovery | null>;
  appUrl: (path?: string) => string;
  deniedMessage: string;
  expiredMessage: string;
  unavailableMessage: string;
}

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

function readFlow(key: string): LoginFlow | null {
  try {
    const value = sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as LoginFlow) : null;
  } catch {
    return null;
  }
}

function saveTokens(key: string, response: TokenResponse): StoredTokens {
  const tokens: StoredTokens = {
    access_token: response.access_token,
    refresh_token: response.refresh_token || '',
    id_token: response.id_token,
    expires_at: Date.now() + response.expires_in * 1000,
    scope: response.scope,
  };
  sessionStorage.setItem(key, JSON.stringify(tokens));
  return tokens;
}

function readTokens(key: string): StoredTokens | null {
  try {
    const value = sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as StoredTokens) : null;
  } catch {
    return null;
  }
}

async function exchangeCode(
  discovery: Discovery,
  clientId: string,
  code: string,
  redirectUri: string,
  verifier: string
) {
  return formRequest<TokenResponse>(discovery.token_endpoint, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

async function refreshAccessToken(
  discovery: Discovery,
  clientId: string,
  refreshToken: string
) {
  return formRequest<TokenResponse>(discovery.token_endpoint, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });
}

async function getUserInfo(discovery: Discovery, accessToken: string) {
  const response = await fetch(discovery.userinfo_endpoint, {
    credentials: 'omit',
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });
  return parseJsonResponse<UserInfo>(response);
}

function logoutUrl(
  discovery: Discovery,
  postLogoutRedirectUri: string,
  idToken?: string
) {
  const url = new URL(discovery.end_session_endpoint);
  url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  if (idToken) url.searchParams.set('id_token_hint', idToken);
  return url.toString();
}

export function createOidcAuth(options: OidcAuthOptions) {
  let refreshPending: Promise<StoredTokens> | null = null;

  async function requireDiscovery() {
    const discovery = await options.discovery();
    if (!discovery) throw new Error(options.unavailableMessage);
    return discovery;
  }

  function getTokens() {
    return readTokens(options.tokenKey);
  }

  function clearTokens() {
    sessionStorage.removeItem(options.tokenKey);
    sessionStorage.removeItem(options.flowKey);
  }

  async function startLogin() {
    const discovery = await requireDiscovery();
    const state = randomValue();
    const verifier = randomValue(48);
    const challenge = await codeChallenge(verifier);
    const flow: LoginFlow = {
      state,
      verifier,
      redirectUri: options.appUrl('/callback'),
    };
    sessionStorage.setItem(options.flowKey, JSON.stringify(flow));

    const authorizationUrl = new URL(discovery.authorization_endpoint);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', options.clientId);
    authorizationUrl.searchParams.set('redirect_uri', flow.redirectUri);
    authorizationUrl.searchParams.set('scope', 'openid profile email');
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge', challenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    window.location.assign(authorizationUrl.toString());
  }

  async function completeLogin(search: string) {
    const params = new URLSearchParams(search);
    const error = params.get('error');
    if (error) {
      throw new Error(params.get('error_description') || options.deniedMessage);
    }

    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) throw new Error('The sign-in response is incomplete');

    const flow = readFlow(options.flowKey);
    if (!flow || flow.state !== state) throw new Error('The sign-in state is invalid');

    const discovery = await requireDiscovery();
    const response = await exchangeCode(
      discovery,
      options.clientId,
      code,
      flow.redirectUri,
      flow.verifier
    );
    sessionStorage.removeItem(options.flowKey);
    saveTokens(options.tokenKey, response);
  }

  async function performRefresh(tokens: StoredTokens) {
    if (!tokens.refresh_token) throw new Error(options.expiredMessage);
    const discovery = await requireDiscovery();
    return saveTokens(
      options.tokenKey,
      await refreshAccessToken(discovery, options.clientId, tokens.refresh_token)
    );
  }

  function refreshTokens() {
    if (!refreshPending) {
      const tokens = getTokens();
      refreshPending = tokens
        ? performRefresh(tokens)
            .catch((error) => {
              clearTokens();
              throw error;
            })
            .finally(() => {
              refreshPending = null;
            })
        : Promise.reject(new Error(options.expiredMessage));
    }
    return refreshPending;
  }

  async function ensureAccessToken() {
    const tokens = getTokens();
    if (!tokens) throw new Error(options.expiredMessage);
    if (tokens.expires_at > Date.now() + 30_000) return tokens.access_token;
    return (await refreshTokens()).access_token;
  }

  async function loadUser(): Promise<UserInfo> {
    let accessToken = await ensureAccessToken();
    try {
      return await getUserInfo(await requireDiscovery(), accessToken);
    } catch (error: any) {
      if ((error as ApiError)?.status !== 401) throw error;
      accessToken = (await refreshTokens()).access_token;
      return getUserInfo(await requireDiscovery(), accessToken);
    }
  }

  async function signOut() {
    const tokens = getTokens();
    clearTokens();
    const discovery = await requireDiscovery();
    window.location.assign(
      logoutUrl(discovery, options.appUrl('/'), tokens?.id_token)
    );
  }

  return {
    getTokens,
    clearTokens,
    startLogin,
    completeLogin,
    refreshTokens,
    ensureAccessToken,
    loadUser,
    signOut,
  };
}
