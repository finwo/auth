import { app } from '../../app.js';
import { authenticateAdminRequest } from '../../lib/admin-auth.js';
import {
  connectAdminProviderDomain,
  createAdminRealmProvider,
  deleteAdminRealmProvider,
  disconnectAdminProviderDomain,
  getAdminRealmProvider,
  listAdminRealmProviders,
  normalizeCreateProviderInput,
  normalizeUpdateProviderInput,
  updateAdminRealmProvider,
} from '../../lib/admin-realm-providers.js';
import { HttpError } from '../../lib/http/http-error.js';

const NO_STORE = { 'cache-control': 'no-store' };

function assertDomainBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object');
  }
  for (const field of Object.keys(body)) {
    if (field !== 'domain') {
      throw new HttpError(400, 'invalid_request', `Unknown field: ${field}`);
    }
  }
}

export default [
  {
    method: 'get',
    path: '/api/v1/admin/realms/:realm/providers',
    name: 'admin.realm-providers.list',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const providers = await listAdminRealmProviders({ realmDb: auth.realmDb });

      return new app.HttpOk({ providers }, NO_STORE);
    },
  },
  {
    method: 'post',
    path: '/api/v1/admin/realms/:realm/providers',
    name: 'admin.realm-providers.create',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const input = normalizeCreateProviderInput(req.body || {});
      const provider = await createAdminRealmProvider({ realmDb: auth.realmDb, input });

      return new app.HttpOk({ ok: true, provider }, NO_STORE);
    },
  },
  {
    method: 'get',
    path: '/api/v1/admin/realms/:realm/providers/:provider',
    name: 'admin.realm-providers.get',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const provider = await getAdminRealmProvider({ realmDb: auth.realmDb, slug: req.params.provider });
      if (!provider) {
        throw new HttpError(404, 'provider_not_found', 'Identity provider not found');
      }

      return new app.HttpOk({ provider }, NO_STORE);
    },
  },
  {
    method: 'patch',
    path: '/api/v1/admin/realms/:realm/providers/:provider',
    name: 'admin.realm-providers.update',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const input = normalizeUpdateProviderInput(req.body || {});
      const provider = await updateAdminRealmProvider({
        realmDb: auth.realmDb,
        slug: req.params.provider,
        input,
      });

      return new app.HttpOk({ ok: true, provider }, NO_STORE);
    },
  },
  {
    method: 'delete',
    path: '/api/v1/admin/realms/:realm/providers/:provider',
    name: 'admin.realm-providers.delete',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const result = await deleteAdminRealmProvider({ realmDb: auth.realmDb, slug: req.params.provider });

      return new app.HttpOk({ ok: true, ...result }, NO_STORE);
    },
  },
  {
    method: 'post',
    path: '/api/v1/admin/realms/:realm/providers/:provider/domains',
    name: 'admin.realm-providers.connect-domain',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      assertDomainBody(req.body || {});
      const result = await connectAdminProviderDomain({
        systemDb: auth.systemDb,
        realm: auth.realm,
        realmDb: auth.realmDb,
        slug: req.params.provider,
        domain: req.body.domain,
      });

      return new app.HttpOk({ ok: true, ...result }, NO_STORE);
    },
  },
  {
    method: 'delete',
    path: '/api/v1/admin/realms/:realm/providers/:provider/domains/:domain',
    name: 'admin.realm-providers.disconnect-domain',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const result = await disconnectAdminProviderDomain({
        realmDb: auth.realmDb,
        slug: req.params.provider,
        domain: req.params.domain,
      });

      return new app.HttpOk({ ok: true, ...result }, NO_STORE);
    },
  },
];
