import { app } from '../../app.js';
import { HttpError } from '../../lib/http/http-error.js';
import { findManagedProviderForUser, resolveLogin } from '../../lib/login.js';
import { verifyDummyPassword, verifyPassword } from '../../lib/password.js';
import { getSystemDatabase, openRealmDatabase, realmMetadata, resolveRealm } from '../../lib/realm.js';
import {
  LONG_SESSION_TTL,
  SHORT_SESSION_TTL,
  createSession,
  purgeExpiredSessions,
  requestIp,
  setSessionCookie,
} from '../../lib/session.js';
import {
  findUserByIdentifier,
  getMembership,
  getPasswordCredential,
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
    if (body.realm != null && typeof body.realm !== 'string') {
      throw new HttpError(400, 'invalid_request', 'realm must be a string');
    }
    if (body.long_session != null && typeof body.long_session !== 'boolean') {
      throw new HttpError(400, 'invalid_request', 'long_session must be a boolean');
    }

    const realm = await resolveRealm({
      host: req.headers.host,
      slug: body.realm || undefined,
    });
    const metadata = await realmMetadata(realm);
    const realmDb = await openRealmDatabase(realm);
    const systemDb = getSystemDatabase();

    if (body.identifier.includes('@')) {
      const resolution = await resolveLogin({ identifier: body.identifier });
      if (resolution.next !== 'password') {
        throw new HttpError(403, 'provider_required', 'This account must sign in with its identity provider');
      }
    }

    const user = await findUserByIdentifier(systemDb, body.identifier);
    const credential = user ? await getPasswordCredential(systemDb, user.id) : null;
    const membership = user ? await getMembership(realmDb, user.id) : null;

    const canCheckPassword =
      user &&
      user.status === 'active' &&
      credential &&
      membership &&
      membership.status === 'active';

    if (!canCheckPassword) {
      await verifyDummyPassword(body.password);
      throw new HttpError(401, 'invalid_credentials', 'Invalid credentials');
    }

    const valid = await verifyPassword(body.password, credential.secret_hash);
    if (!valid) {
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

    await purgeExpiredSessions(realmDb);
    const { token, session } = await createSession(realmDb, {
      userId: user.id,
      ttl,
      userAgent: req.headers['user-agent'] || null,
      ip: requestIp(req),
    });
    setSessionCookie(res, req, realm, token, ttl);
    await updateLastLogin(systemDb, user.id);

    return new app.HttpOk({
      realm: metadata,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
      },
      expires_at: session.expires_at,
    });
  },
};
