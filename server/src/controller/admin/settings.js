import { app } from '../../app.js';
import { authenticateAdminRequest } from '../../lib/admin-auth.js';
import {
  getAdminRealmSettings,
  updateAdminRealmSettings,
} from '../../lib/admin-settings.js';

export default [
  {
    method: 'get',
    path: '/api/v1/admin/realms/:realm/settings',
    name: 'admin.settings.get',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const settings = await getAdminRealmSettings(auth.realmDb, auth.realm.slug);

      return new app.HttpOk({ settings }, { 'cache-control': 'no-store' });
    },
  },
  {
    method: 'patch',
    path: '/api/v1/admin/realms/:realm/settings',
    name: 'admin.settings.update',
    async handler(req) {
      const auth = await authenticateAdminRequest(req, {
        realmSlug: req.params.realm,
      });
      const settings = await updateAdminRealmSettings({
        realmDb: auth.realmDb,
        realmSlug: auth.realm.slug,
        body: req.body || {},
      });

      return new app.HttpOk({ ok: true, settings }, { 'cache-control': 'no-store' });
    },
  },
];
