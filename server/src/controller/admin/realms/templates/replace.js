import { app } from '../../../../app.js';
import { authenticateSystemAdmin } from '../../../../lib/admin-auth.js';
import { replaceRealmTemplateLayers } from '../../../../lib/packages.js';
import { resolveRealm } from '../../../../lib/realm.js';

export default {
  method: 'put',
  path: '/api/v1/admin/realms/:realm/templates',
  name: 'admin.realms.templates.replace',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    const realm = await resolveRealm({ slug: req.params.realm });
    const body = req.body || {};
    const packageIds = body.package_ids ?? body.layer_ids;
    const layers = await replaceRealmTemplateLayers(auth.systemDb, {
      realmId: realm.id,
      packageIds,
    });

    return new app.HttpOk({ layers }, { 'cache-control': 'no-store' });
  },
};
