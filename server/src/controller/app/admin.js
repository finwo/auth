import { app } from '../../app.js';
import { serveAppConfig } from '../../lib/app-assets.js';
import { serveAppDocument } from '../../lib/apps.js';
import { resolveHostContext } from '../../lib/host-context.js';
import { HttpError } from '../../lib/http/http-error.js';

export default {
  mount: '/app/admin',
  name: 'app.admin',
  async handler(req, res) {
    try {
      const hostContext = await resolveHostContext(req, {
        publicUrl: app.config.server.public_url,
      });
      if (hostContext.mode !== 'canonical') {
        throw new HttpError(404, 'not_found', 'Not found');
      }

      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/app/admin/config.json' || url.pathname === '/config.json') {
        await serveAppConfig(req, res, { appName: 'admin', clientId: 'admin' });
        return;
      }

      serveAppDocument(res, 'admin');
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
