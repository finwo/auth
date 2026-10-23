import { app } from '../../../../app.js';
import { authenticateSystemAdmin } from '../../../../lib/admin-auth.js';
import { resolveRealm } from '../../../../lib/realm.js';
import { replaceRealmTemplateLayers } from '../../../../lib/templates.js';

export default {
  method: 'put',
  path: '/api/v1/admin/realms/:realm/templates',
  name: 'admin.realms.templates.replace',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    const realm = await resolveRealm({ slug: req.params.realm });
    const layers = await replaceRealmTemplateLayers(auth.systemDb, {
      realmId: realm.id,
      layerIds: (req.body || {}).layer_ids,
    });

    return new app.HttpOk({ layers }, { 'cache-control': 'no-store' });
  },
};
