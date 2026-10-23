import { app } from '../../../../app.js';
import { authenticateSystemAdmin } from '../../../../lib/admin-auth.js';
import { resolveRealm } from '../../../../lib/realm.js';
import { listRealmTemplateLayers } from '../../../../lib/packages.js';

export default {
  method: 'get',
  path: '/api/v1/admin/realms/:realm/templates',
  name: 'admin.realms.templates.list',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    const realm = await resolveRealm({ slug: req.params.realm });
    const layers = await listRealmTemplateLayers(auth.systemDb, realm.id);

    return new app.HttpOk({ layers }, { 'cache-control': 'no-store' });
  },
};
