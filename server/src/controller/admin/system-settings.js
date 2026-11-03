import { app } from '../../app.js';
import { authenticateAdminSession } from '../../lib/admin-auth.js';
import { HttpError } from '../../lib/http/http-error.js';
import { isSystemAdmin } from '../../lib/policy.js';
import {
  getAdminSystemSettings,
  updateAdminSystemSettings,
} from '../../lib/system-settings.js';

function requireSystemAdmin(user) {
  if (!isSystemAdmin(user)) {
    throw new HttpError(403, 'forbidden', 'System administrator access is required');
  }
}

export default [
  {
    method: 'get',
    path: '/api/v1/admin/system/settings',
    name: 'admin.system-settings.get',
    async handler(req) {
      const auth = await authenticateAdminSession(req);
      requireSystemAdmin(auth.user);
      const settings = await getAdminSystemSettings(auth.systemDb);

      return new app.HttpOk({ settings }, { 'cache-control': 'no-store' });
    },
  },
  {
    method: 'patch',
    path: '/api/v1/admin/system/settings',
    name: 'admin.system-settings.update',
    async handler(req) {
      const auth = await authenticateAdminSession(req);
      requireSystemAdmin(auth.user);
      const settings = await updateAdminSystemSettings({
        systemDb: auth.systemDb,
        body: req.body || {},
      });

      return new app.HttpOk({ ok: true, settings }, { 'cache-control': 'no-store' });
    },
  },
];
