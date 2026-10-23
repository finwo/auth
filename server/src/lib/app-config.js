import { app } from '../app.js';
import { resolveHostContext, resolveClientForHost } from './host-context.js';
import { HttpError } from './http/http-error.js';
import { requestOrigin } from './oidc/context.js';
import { templateConfigLayers } from './packages.js';
import { getSystemDatabase } from './realm.js';

export async function buildAppConfig(req, { appName, clientId }) {
  const context = await resolveHostContext(req, {
    publicUrl: app.config.server.public_url,
  });
  const origin = requestOrigin(req);

  let resolvedClientId = clientId || null;
  if (context.mode === 'client') {
    if (resolvedClientId && resolvedClientId !== context.clientId) {
      throw new HttpError(404, 'not_found', 'Not found');
    }
    resolvedClientId = context.clientId;
  } else {
    if (!resolvedClientId) {
      throw new HttpError(400, 'invalid_request', 'client_id is required');
    }
    await resolveClientForHost(context, resolvedClientId);
  }

  const openidConfiguration =
    context.mode === 'client'
      ? `${origin}/oidc/openid-configuration`
      : `${origin}/oidc/${encodeURIComponent(resolvedClientId)}/openid-configuration`;

  let layers;
  try {
    layers = await templateConfigLayers(getSystemDatabase(), context);
  } catch {
    throw new HttpError(503, 'template_build_missing', 'Template build missing');
  }

  return {
    auth_url: origin,
    openid_configuration: openidConfiguration,
    templateLayers: layers.map((layer) => ({
      digest: layer.digest,
      url: `${origin}${layer.url}`,
    })),
  };
}
