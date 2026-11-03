import {
  applyBrandingPatch,
  hasBrandingPatch,
  normalizeBrandingObject,
  normalizeBrandingPatch,
  serializeBranding,
} from './admin-branding.js';
import { HttpError } from './http/http-error.js';

const ALLOWED_FIELDS = new Set(['logo_url', 'primary_color']);

function invalidRequest(message) {
  return new HttpError(400, 'invalid_request', message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serializeSettings(row) {
  return {
    ...serializeBranding(row.branding),
    updated_at: row.updated_at,
  };
}

export function normalizeSystemSettingsPatch(body) {
  if (!isPlainObject(body)) {
    throw invalidRequest('Request body must be a JSON object');
  }

  for (const field of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw invalidRequest(`Unknown field: ${field}`);
    }
  }

  if (Object.keys(body).length === 0) {
    throw invalidRequest('At least one setting must be provided');
  }

  return normalizeBrandingPatch(body);
}

async function loadSystemSettingsRow(systemDb) {
  const row = await systemDb.get(
    `SELECT branding, created_at, updated_at
       FROM system_settings
      WHERE id = 1`
  );
  if (row) return row;

  const now = Date.now();
  await systemDb.run(
    `INSERT INTO system_settings
      (id, branding, created_at, updated_at)
     VALUES
      (1, '{}', {createdAt}, {updatedAt})`,
    { createdAt: now, updatedAt: now }
  );

  const created = await systemDb.get(
    `SELECT branding, created_at, updated_at
       FROM system_settings
      WHERE id = 1`
  );
  if (!created) {
    throw new HttpError(500, 'internal_error', 'System settings are unavailable');
  }
  return created;
}

export async function getSystemBranding(systemDb) {
  const row = await loadSystemSettingsRow(systemDb);
  return normalizeBrandingObject(row.branding);
}

export async function getAdminSystemSettings(systemDb) {
  const row = await loadSystemSettingsRow(systemDb);
  return serializeSettings(row);
}

export async function updateAdminSystemSettings({ systemDb, body, now = Date.now() }) {
  const input = normalizeSystemSettingsPatch(body);

  return systemDb.transaction(async (tx) => {
    const current = await loadSystemSettingsRow(tx);
    const branding = hasBrandingPatch(input)
      ? applyBrandingPatch(current.branding, input)
      : current.branding;

    await tx.run(
      `UPDATE system_settings
          SET branding = {branding},
              updated_at = {now}
        WHERE id = 1`,
      { branding, now }
    );

    const updated = await loadSystemSettingsRow(tx);
    return serializeSettings(updated);
  });
}
