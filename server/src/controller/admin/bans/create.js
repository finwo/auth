import { app } from '../../../app.js';
import { authenticateAdminRequest } from '../../../lib/admin-auth.js';
import {
  createBan,
  revokeBannedClientAccess,
  revokeBannedRealmAccess,
  serializeBan,
} from '../../../lib/bans.js';
import { HttpError } from '../../../lib/http/http-error.js';
import { getClient } from '../../../lib/oidc/clients.js';
import { findUserById } from '../../../lib/users.js';

export default {
  method: 'post',
  path: '/api/v1/admin/realms/:realm/users/:userId/bans',
  name: 'admin.bans.create',
  async handler(req) {
    const auth = await authenticateAdminRequest(req, {
      realmSlug: req.params.realm,
    });
    const body = req.body || {};
    if (typeof body.client_id !== 'string' || !body.client_id) {
      throw new HttpError(400, 'invalid_request', 'client_id is required');
    }

    const user = await findUserById(auth.systemDb, req.params.userId);
    if (!user) {
      throw new HttpError(404, 'user_not_found', 'User not found');
    }

    const clientId = body.client_id;
    if (clientId !== '*') {
      const client = await getClient(auth.realmDb, clientId);
      if (!client || client.system_client) {
        throw new HttpError(404, 'client_not_found', 'Client not found');
      }
    }

    const now = Date.now();
    const ban = await createBan(auth.realmDb, {
      userId: user.id,
      clientId,
      createdBy: auth.user.id,
      now,
    });

    if (clientId === '*') {
      await revokeBannedRealmAccess(auth.systemDb, {
        userId: user.id,
        realmId: auth.realm.id,
        now,
      });
    } else {
      await revokeBannedClientAccess(auth.systemDb, {
        userId: user.id,
        realmId: auth.realm.id,
        clientId,
        now,
      });
    }

    return new app.HttpOk(
      { ok: true, ban: serializeBan(ban) },
      { 'cache-control': 'no-store' }
    );
  },
};
