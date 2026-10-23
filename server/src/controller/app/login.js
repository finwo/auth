import { app } from '../../app.js';
import { serveAppConfig, serveTemplateAsset } from '../../lib/app-assets.js';
import { resolveHostContext } from '../../lib/host-context.js';
import { HttpError } from '../../lib/http/http-error.js';

export default {
  mount: '/app/login',
  name: 'app.login',
  async handler(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/app/login/config.json' || url.pathname === '/config.json') {
        await serveAppConfig(req, res, {
          appName: 'login',
          clientId: url.searchParams.get('client_id'),
        });
        return;
      }

      const asset =
        /^(?:\/app\/login)?\/static\/([a-f0-9]{64})\.tar\.gz$/.exec(url.pathname);
      if (asset) {
        await resolveHostContext(req, {
          publicUrl: app.config.server.public_url,
        });
        if (!(await serveTemplateAsset(req, res, asset[1]))) {
          throw new HttpError(404, 'not_found', 'Not found');
        }
        return;
      }

      throw new HttpError(404, 'not_found', 'Not found');
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
