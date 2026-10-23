import { app } from '../app.js';
import { HttpError } from './http/http-error.js';
import { resolveHostContext } from './host-context.js';
import { systemIssuer } from './oidc/context.js';
import { verifyToken } from './oidc/keys.js';
import { isRealmAdmin, isSystemAdmin } from './policy.js';
import { getSystemDatabase, openRealmDatabase, resolveRealm } from './realm.js';
import { findUserById, getMembership, getUserRoles } from './users.js';

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

export async function authenticateAdminSession(req) {
  const hostContext = await resolveHostContext(req, {
    publicUrl: app.config.server.public_url,
  });
  if (hostContext.mode !== 'canonical') {
    throw new HttpError(404, 'not_found', 'Not found');
  }

  const token = bearerToken(req);
  if (!token) {
    throw new HttpError(401, 'invalid_token', 'A bearer token is required');
  }

  const systemDb = getSystemDatabase();
  let payload;
  try {
    payload = await verifyToken(systemDb, token, {
      issuer: systemIssuer(app.config.server.public_url),
      audience: 'admin',
      table: 'system_signing_keys',
    });
  } catch {
    throw new HttpError(401, 'invalid_token', 'The access token is invalid');
  }

  if (payload.client_id !== 'admin' || !payload.sub || !payload.sid) {
    throw new HttpError(401, 'invalid_token', 'The access token is invalid');
  }

  const user = await findUserById(systemDb, payload.sub);
  if (!user || user.status !== 'active') {
    throw new HttpError(401, 'invalid_token', 'The user is not available');
  }

  const session = await systemDb.get(
    `SELECT id, user_id
       FROM sessions
      WHERE id = {id} AND user_id = {userId} AND expires_at > {now}`,
    { id: payload.sid, userId: user.id, now: Date.now() }
  );
  if (!session) {
    throw new HttpError(401, 'invalid_token', 'The admin session is not active');
  }

  return { systemDb, user, session };
}

export async function authenticateSystemAdmin(req) {
  const auth = await authenticateAdminSession(req);
  if (!isSystemAdmin(auth.user)) {
    throw new HttpError(403, 'forbidden', 'System administrator access is required');
  }
  return auth;
}

export async function authenticateAdminRequest(req, { realmSlug }) {
  const auth = await authenticateAdminSession(req);
  const { systemDb, user, session } = auth;

  const realm = await resolveRealm({ slug: realmSlug });
  const realmDb = await openRealmDatabase(realm);
  const membership = await getMembership(realmDb, user.id);
  const roles = await getUserRoles(realmDb, user.id);
  if (
    !isSystemAdmin(user) &&
    !(membership?.status === 'active' && isRealmAdmin(roles))
  ) {
    throw new HttpError(403, 'forbidden', 'Realm admin access is required');
  }

  return { systemDb, realmDb, realm, user, membership, roles, session };
}
