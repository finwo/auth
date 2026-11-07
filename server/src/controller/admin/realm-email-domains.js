import { app } from '../../app.js';
import { authenticateAdminRequest } from '../../lib/admin-auth.js';
import {
  addAdminRealmEmailDomain,
  deleteAdminRealmEmailDomain,
  listAdminRealmEmailDomains,
  verifyAdminRealmEmailDomain,
} from '../../lib/admin-realm-email-domains.js';
import { HttpError } from '../../lib/http/http-error.js';
import { isSystemAdmin } from '../../lib/policy.js';

function assertCreateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object');
  }
  for (const field of Object.keys(body)) {
    if (field !== 'domain') {
      throw new HttpError(400, 'invalid_request', `Unknown field: ${field}`);
    }
  }
}

function assertVerifyBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object');
  }
  const keys = Object.keys(body);
  for (const field of keys) {
    if (field !== 'verified') {
      throw new HttpError(400, 'invalid_request', `Unknown field: ${field}`);
    }
  }
  if (keys.length !== 1 || body.verified !== true) {
    throw new HttpError(400, 'invalid_request', 'verified must be true');
  }
}

export default [
  {
    method: 'get',
    path: '/api/v1/admin/realms/:realm/email-domains',
    name: 'admin.realm-email-domains.list',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const email_domains = await listAdminRealmEmailDomains({
        systemDb: auth.systemDb,
        realm: auth.realm,
      });

      return new app.HttpOk({ email_domains }, { 'cache-control': 'no-store' });
    },
  },
  {
    method: 'post',
    path: '/api/v1/admin/realms/:realm/email-domains',
    name: 'admin.realm-email-domains.create',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const body = req.body || {};
      assertCreateBody(body);
      const email_domain = await addAdminRealmEmailDomain({
        systemDb: auth.systemDb,
        realm: auth.realm,
        domain: body.domain,
        isSystemAdmin: isSystemAdmin(auth.user),
      });

      return new app.HttpOk({ ok: true, email_domain }, { 'cache-control': 'no-store' });
    },
  },
  {
    method: 'patch',
    path: '/api/v1/admin/realms/:realm/email-domains/:domain',
    name: 'admin.realm-email-domains.verify',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      assertVerifyBody(req.body || {});
      const email_domain = await verifyAdminRealmEmailDomain({
        systemDb: auth.systemDb,
        realm: auth.realm,
        domain: req.params.domain,
      });

      return new app.HttpOk({ ok: true, email_domain }, { 'cache-control': 'no-store' });
    },
  },
  {
    method: 'delete',
    path: '/api/v1/admin/realms/:realm/email-domains/:domain',
    name: 'admin.realm-email-domains.delete',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const result = await deleteAdminRealmEmailDomain({
        systemDb: auth.systemDb,
        realm: auth.realm,
        domain: req.params.domain,
      });

      return new app.HttpOk({ ok: true, ...result }, { 'cache-control': 'no-store' });
    },
  },
];
