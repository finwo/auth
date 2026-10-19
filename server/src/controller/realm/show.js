import { app } from '../../app.js';
import { realmMetadata, resolveRealm } from '../../lib/realm.js';

export default {
  method: 'get',
  path: '/api/v1/realm',
  name: 'realm.show',
  async handler(req) {
    const url = new URL(req.url, 'http://localhost');
    const realm = await resolveRealm({
      host: req.headers.host,
      slug: url.searchParams.get('realm') || undefined,
    });
    return new app.HttpOk(await realmMetadata(realm));
  },
};
