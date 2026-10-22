import { resolveClientForHost, resolveHostContext } from './host-context.js';
import { HttpError } from './http/http-error.js';
import { getClient, getSystemClient } from './oidc/clients.js';
import { getAuthRequest, readAuthRequestId } from './oidc/requests.js';
import { getSystemDatabase, openRealmDatabase } from './realm.js';
import { authenticateRequest } from './session.js';

export async function resolveConsentRequest({ req, res, publicUrl, clientId }) {
  const hostContext = await resolveHostContext(req, { publicUrl });
  const target = await resolveClientForHost(
    hostContext,
    clientId || hostContext.clientId
  );
  const realmDb = target.realm ? await openRealmDatabase(target.realm) : null;
  const systemDb = getSystemDatabase();
  const client = target.systemClient
    ? getSystemClient(target.clientId)
    : await getClient(realmDb, target.clientId);

  if (!client || !client.enabled) {
    throw new HttpError(404, 'unknown_client', 'Unknown client');
  }
  if (client.system_client) {
    throw new HttpError(400, 'invalid_request', 'System clients do not use consent');
  }

  const auth = await authenticateRequest({
    systemDb,
    realmDb,
    req,
    res,
    context: hostContext,
  });
  if (!auth) {
    throw new HttpError(401, 'not_authenticated', 'Not signed in');
  }

  const store = realmDb;
  const pending = await getAuthRequest(store, readAuthRequestId(req, target));
  if (!pending || pending.completed_at || pending.client_id !== client.client_id) {
    throw new HttpError(
      400,
      'invalid_request',
      'There is no pending authorization request'
    );
  }
  if (pending.user_id !== auth.user.id || pending.session_id !== auth.session.id) {
    throw new HttpError(
      409,
      'consent_not_ready',
      'The authorization request is not ready for consent'
    );
  }

  return {
    hostContext,
    target,
    realmDb,
    systemDb,
    client,
    pending,
    store,
    auth,
  };
}
