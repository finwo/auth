import { app } from '../../app.js';
import { resolveClientForHost, resolveHostContext } from '../../lib/host-context.js';
import { HttpError } from '../../lib/http/http-error.js';
import { findManagedProviderForUser, resolveLogin } from '../../lib/login.js';
import { getClient } from '../../lib/oidc/clients.js';
import {
  getAuthRequest,
  readAuthRequestId,
  selectAuthRequestAccount,
} from '../../lib/oidc/requests.js';
import { verifyDummyPassword, verifyPassword } from '../../lib/password.js';
import { canUseClient } from '../../lib/policy.js';
import { getSystemDatabase, openRealmDatabase, realmMetadata } from '../../lib/realm.js';
import {
  LONG_SESSION_TTL,
  SHORT_SESSION_TTL,
  createHostSession,
  purgeExpiredSessions,
  reauthenticateSession,
  requestIp,
  requestToken,
  setSessionCookie,
} from '../../lib/session.js';
import {
  findUserByIdentifier,
  getMembership,
  getPasswordCredential,
  getUserRoles,
  updateLastLogin,
} from '../../lib/users.js';

export default {
  method: 'post',
  path: '/api/v1/login/password',
  name: 'login.password',
  async handler(req, res) {
    const body = req.body || {};
    if (typeof body.identifier !== 'string') {
      throw new HttpError(400, 'invalid_request', 'identifier is required');
    }
    if (typeof body.password !== 'string') {
      throw new HttpError(400, 'invalid_request', 'password is required');
    }
    if (body.password.length > 1024) {
      throw new HttpError(400, 'invalid_request', 'password is too long');
    }
    if (typeof body.client_id !== 'string') {
      throw new HttpError(400, 'invalid_request', 'client_id is required');
    }
    if (body.long_session != null && typeof body.long_session !== 'boolean') {
      throw new HttpError(400, 'invalid_request', 'long_session must be a boolean');
    }

    const hostContext = await resolveHostContext(req, {
      publicUrl: app.config.server.public_url,
    });
    const { realm, clientId } = await resolveClientForHost(hostContext, body.client_id);
    const metadata = await realmMetadata(realm);
    const realmDb = await openRealmDatabase(realm);
    const systemDb = getSystemDatabase();
    const client = await getClient(realmDb, clientId);
    if (!client || !client.enabled) {
      throw new HttpError(404, 'unknown_client', 'Unknown client');
    }

    if (body.identifier.includes('@')) {
      const resolution = await resolveLogin({ identifier: body.identifier });
      if (resolution.next !== 'password') {
        throw new HttpError(403, 'provider_required', 'This account must sign in with its identity provider');
      }
    }

    const user = await findUserByIdentifier(systemDb, body.identifier);
    const credential = user ? await getPasswordCredential(systemDb, user.id) : null;
    const membership = user ? await getMembership(realmDb, user.id) : null;
    const roles = user ? await getUserRoles(realmDb, user.id) : [];
    const pendingId = readAuthRequestId(req, realm);
    const pending = pendingId ? await getAuthRequest(realmDb, pendingId) : null;
    const pendingClient = pending && !pending.completed_at && pending.client_id === client.client_id;

    if (!credential) {
      await verifyDummyPassword(body.password);
      throw new HttpError(401, 'invalid_credentials', 'Invalid credentials');
    }

    const valid = await verifyPassword(body.password, credential.secret_hash);
    if (!valid) {
      throw new HttpError(401, 'invalid_credentials', 'Invalid credentials');
    }

    if (!user || user.status !== 'active') {
      throw new HttpError(401, 'invalid_credentials', 'Invalid credentials');
    }

    const allowedByPolicy = canUseClient({
      user,
      membership,
      roles,
      client,
      realm,
    });
    const member = membership && membership.status === 'active';
    const publicNonMember = client.access_mode === 'public' && !client.virtual && pendingClient;
    const allowed =
      allowedByPolicy &&
      (member || client.virtual || publicNonMember || user.is_system_admin);

    if (!allowed) {
      throw new HttpError(401, 'invalid_credentials', 'Invalid credentials');
    }

    if (!body.identifier.includes('@')) {
      const provider = await findManagedProviderForUser(systemDb, user);
      if (provider && !provider.enabled) {
        throw new HttpError(409, 'provider_disabled', 'The identity provider for this account is unavailable');
      }
      if (provider) {
        throw new HttpError(403, 'provider_required', 'This account must sign in with its identity provider');
      }
    }

    const longSession = body.long_session === true && metadata.allow_session_duration_choice;
    const ttl = longSession ? LONG_SESSION_TTL : SHORT_SESSION_TTL;

    await purgeExpiredSessions(systemDb);
    const { token, session } = await createHostSession(systemDb, {
      context: hostContext,
      token: requestToken(req),
      userId: user.id,
      ttl,
      userAgent: req.headers['user-agent'] || null,
      ip: requestIp(req),
    });
    const authTime = await reauthenticateSession(systemDb, {
      sessionId: session.id,
      realmId: realm.id,
    });
    setSessionCookie(res, req, token, session.ttl);
    if (pendingClient && pending) {
      await selectAuthRequestAccount(realmDb, pending.id, {
        userId: user.id,
        sessionId: session.id,
        authTime,
      });
    }
    await updateLastLogin(systemDb, user.id);

    return new app.HttpOk({
      realm: metadata,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
      },
      expires_at: session.expires_at,
      pending_auth_request: Boolean(pendingClient),
    });
  },
};
