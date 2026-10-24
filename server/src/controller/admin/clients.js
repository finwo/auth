import { app } from '../../app.js';
import { authenticateAdminRequest } from '../../lib/admin-auth.js';
import {
  createAdminRealmClient,
  deleteAdminRealmClient,
  listAdminRealmClients,
  normalizeCreateInput,
  rotateAdminClientSecret,
  updateAdminRealmClient,
} from '../../lib/admin-clients.js';

export default [
  {
    method: 'get',
    path: '/api/v1/admin/realms/:realm/clients',
    name: 'admin.clients.list',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const clients = await listAdminRealmClients(auth.systemDb, auth.realmDb, auth.realm.id);

      return new app.HttpOk({ clients }, { 'cache-control': 'no-store' });
    },
  },
  {
    method: 'post',
    path: '/api/v1/admin/realms/:realm/clients',
    name: 'admin.clients.create',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const input = normalizeCreateInput(req.body || {});
      const { client, client_secret: clientSecret } = await createAdminRealmClient({
        systemDb: auth.systemDb,
        realmDb: auth.realmDb,
        realmId: auth.realm.id,
        input,
      });

      const response = { ok: true, client };
      if (clientSecret) response.client_secret = clientSecret;
      return new app.HttpOk(response, { 'cache-control': 'no-store' });
    },
  },
  {
    method: 'patch',
    path: '/api/v1/admin/realms/:realm/clients/:clientId',
    name: 'admin.clients.update',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const client = await updateAdminRealmClient({
        realmDb: auth.realmDb,
        clientId: req.params.clientId,
        body: req.body || {},
      });

      return new app.HttpOk({ ok: true, client }, { 'cache-control': 'no-store' });
    },
  },
  {
    method: 'delete',
    path: '/api/v1/admin/realms/:realm/clients/:clientId',
    name: 'admin.clients.delete',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const result = await deleteAdminRealmClient({
        systemDb: auth.systemDb,
        realmDb: auth.realmDb,
        realmId: auth.realm.id,
        clientId: req.params.clientId,
      });

      return new app.HttpOk(
        { ok: true, removed: result.removed, client_id: req.params.clientId },
        { 'cache-control': 'no-store' }
      );
    },
  },
  {
    method: 'post',
    path: '/api/v1/admin/realms/:realm/clients/:clientId/secret',
    name: 'admin.clients.rotate_secret',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const { client, client_secret: clientSecret } = await rotateAdminClientSecret({
        realmDb: auth.realmDb,
        clientId: req.params.clientId,
      });

      return new app.HttpOk(
        { ok: true, client_id: client.client_id, client: client, client_secret: clientSecret },
        { 'cache-control': 'no-store' }
      );
    },
  },
];
