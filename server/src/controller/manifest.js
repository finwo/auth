import { app } from '../app.js';

export default {
  method: 'get',
  path: '/api/v1/manifest.json',
  name: 'manifest',
  async handler() {
    return new app.HttpOk(app.manifest);
  },
};
