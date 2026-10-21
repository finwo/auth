import { app } from '../../app.js';
import { serveAppDocument } from '../../lib/apps.js';
import { resolveHostContext } from '../../lib/host-context.js';
import { HttpError } from '../../lib/http/http-error.js';

export default {
  mount: '/app/account',
  name: 'app.account',
  async handler(req, res) {
    try {
      await resolveHostContext(req, {
        publicUrl: app.config.server.public_url,
      });
      serveAppDocument(res, 'account');
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof HttpError) {
        e.toResponse().send(res);
        return;
      }
      console.error(e);
      new HttpError(500, 'internal_error', 'Internal server error').toResponse().send(res);
    }
  },
};
