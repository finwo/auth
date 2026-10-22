import { createOidcAuth, type StoredTokens } from '@api/oidc';
import { appUrl, getDiscovery } from './api';

export type AccountTokens = StoredTokens;

const auth = createOidcAuth({
  clientId: 'account',
  tokenKey: 'account_tokens',
  flowKey: 'account_oidc_flow',
  discovery: getDiscovery,
  appUrl,
  deniedMessage: 'Account sign-in was denied',
  expiredMessage: 'The account session has expired',
  unavailableMessage: 'This host does not offer the account client',
});

export const getAccountTokens = auth.getTokens;
export const clearAccountTokens = auth.clearTokens;
export const startAccountLogin = auth.startLogin;
export const completeAccountLogin = auth.completeLogin;
export const refreshAccountTokens = auth.refreshTokens;
export const ensureAccountAccessToken = auth.ensureAccessToken;
export const loadAccountUser = auth.loadUser;
export const accountSignOut = auth.signOut;
