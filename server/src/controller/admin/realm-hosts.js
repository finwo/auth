import { app } from '../../app.js';
import { authenticateAdminRequest } from '../../lib/admin-auth.js';
import {
  addAdminRealmHost,
  deleteAdminRealmHost,
  listAdminRealmHosts,
  normalizeReservedHosts,
} from '../../lib/admin-realm-hosts.js';
import { HttpError } from '../../lib/http/http-error.js';
import { isSystemAdmin } from '../../lib/policy.js';

const reservedHosts = normalizeReservedHosts(app.config);

function assertBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object');
  }
  for (const field of Object.keys(body)) {
    if (field !== 'host') {
      throw new HttpError(400, 'invalid_request', `Unknown field: ${field}`);
    }
  }
}

export default [
  {
    method: 'get',
    path: '/api/v1/admin/realms/:realm/hosts',
    name: 'admin.realm-hosts.list',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const hosts = await listAdminRealmHosts({
        systemDb: auth.systemDb,
        realm: auth.realm,
      });

      return new app.HttpOk({ hosts }, { 'cache-control': 'no-store' });
    },
  },
  {
    method: 'post',
    path: '/api/v1/admin/realms/:realm/hosts',
    name: 'admin.realm-hosts.create',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const body = req.body || {};
      assertBody(body);
      const host = await addAdminRealmHost({
        systemDb: auth.systemDb,
        realm: auth.realm,
        host: body.host,
        isSystemAdmin: isSystemAdmin(auth.user),
        reservedHosts,
      });

      return new app.HttpOk({ ok: true, host }, { 'cache-control': 'no-store' });
    },
  },
  {
    method: 'delete',
    path: '/api/v1/admin/realms/:realm/hosts/:host',
    name: 'admin.realm-hosts.delete',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const result = await deleteAdminRealmHost({
        systemDb: auth.systemDb,
        realm: auth.realm,
        host: req.params.host,
      });

      return new app.HttpOk({ ok: true, ...result }, { 'cache-control': 'no-store' });
    },
  },
];
