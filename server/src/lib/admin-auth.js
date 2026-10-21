import { app } from '../app.js';
import { HttpError } from './http/http-error.js';
import { resolveHostContext } from './host-context.js';
import { canonicalIssuer } from './oidc/context.js';
import { verifyToken } from './oidc/keys.js';
import { isRealmAdmin, isSystemAdmin } from './policy.js';
import { getSystemDatabase, openRealmDatabase, resolveRealm } from './realm.js';
import { findUserById, getMembership, getUserRoles } from './users.js';

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

export async function authenticateAdminRequest(req, { realmSlug }) {
  const hostContext = await resolveHostContext(req, {
    publicUrl: app.config.server.public_url,
  });
  if (hostContext.mode === 'client') {
    throw new HttpError(404, 'not_found', 'Not found');
  }

  const realm = await resolveRealm({
    host: hostContext.host,
    slug: realmSlug,
  });
  const realmDb = await openRealmDatabase(realm);
  const token = bearerToken(req);
  if (!token) {
    throw new HttpError(401, 'invalid_token', 'A bearer token is required');
  }

  let payload;
  try {
    payload = await verifyToken(realmDb, token, {
      issuer: canonicalIssuer(app.config.server.public_url, realm.slug),
      audience: 'admin',
    });
  } catch {
    throw new HttpError(401, 'invalid_token', 'The access token is invalid');
  }

  if (payload.client_id !== 'admin' || !payload.sub || !payload.sid) {
    throw new HttpError(401, 'invalid_token', 'The access token is invalid');
  }

  const systemDb = getSystemDatabase();
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
