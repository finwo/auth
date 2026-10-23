import { app } from '../../../app.js';
import { authenticateSystemAdmin } from '../../../lib/admin-auth.js';
import { listPackages } from '../../../lib/packages.js';

export default {
  method: 'get',
  path: '/api/v1/admin/packages',
  name: 'admin.packages.list',
  async handler(req) {
    const auth = await authenticateSystemAdmin(req);
    const packages = await listPackages(auth.systemDb);

    return new app.HttpOk(
      { packages },
      { 'cache-control': 'no-store' }
    );
  },
};
