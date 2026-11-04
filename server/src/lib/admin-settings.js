import {
  applyBrandingPatch,
  hasBrandingPatch,
  normalizeBrandingPatch,
  serializeBranding,
} from './admin-branding.js';
import { HttpError } from './http/http-error.js';

const DISPLAY_NAME_MAX_LENGTH = 100;
const ALLOWED_FIELDS = new Set([
  'display_name',
  'allow_session_duration_choice',
  'logo_url',
  'primary_color',
]);

function invalidRequest(message) {
  return new HttpError(400, 'invalid_request', message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateDisplayName(value) {
  if (typeof value !== 'string') {
    throw invalidRequest('display_name must be a string');
  }

  const displayName = value.trim();
  if (!displayName) {
    throw invalidRequest('display_name must not be empty');
  }
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    throw invalidRequest(
      `display_name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`
    );
  }
  if (/[\r\n]/.test(displayName)) {
    throw invalidRequest('display_name must be a single line');
  }

  return displayName;
}

function validateAllowSessionDurationChoice(value) {
  if (typeof value !== 'boolean') {
    throw invalidRequest('allow_session_duration_choice must be a boolean');
  }
  return value;
}

function serializeSettings(row, realmSlug) {
  return {
    slug: realmSlug,
    display_name: row.display_name,
    allow_session_duration_choice: Boolean(row.allow_session_duration_choice),
    ...serializeBranding(row.branding),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function loadSettingsRow(realmDb, realmSlug) {
  const row = await realmDb.get(
    `SELECT slug, display_name, branding, allow_session_duration_choice,
            created_at, updated_at
       FROM realm_settings
      WHERE id = 1`
  );

  if (!row || row.slug !== realmSlug) {
    throw new HttpError(404, 'realm_not_found', 'Realm settings not found');
  }

  return row;
}

export function normalizeAdminRealmSettingsPatch(body) {
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

  const input = {};

  if (Object.hasOwn(body, 'display_name')) {
    input.display_name = validateDisplayName(body.display_name);
  }
  if (Object.hasOwn(body, 'allow_session_duration_choice')) {
    input.allow_session_duration_choice = validateAllowSessionDurationChoice(
      body.allow_session_duration_choice
    );
  }

  Object.assign(input, normalizeBrandingPatch(body));

  return input;
}

export async function getAdminRealmSettings(realmDb, realmSlug) {
  const row = await loadSettingsRow(realmDb, realmSlug);
  return serializeSettings(row, realmSlug);
}

export async function updateAdminRealmSettings({
  realmDb,
  realmSlug,
  body,
  now = Date.now(),
}) {
  const input = normalizeAdminRealmSettingsPatch(body);
  const current = await loadSettingsRow(realmDb, realmSlug);

  const displayName = Object.hasOwn(input, 'display_name')
    ? input.display_name
    : current.display_name;
  const allowSessionDurationChoice = Object.hasOwn(input, 'allow_session_duration_choice')
    ? input.allow_session_duration_choice
    : Boolean(current.allow_session_duration_choice);
  const branding = hasBrandingPatch(input)
    ? applyBrandingPatch(current.branding, input)
    : current.branding;

  await realmDb.run(
    `UPDATE realm_settings
        SET display_name = {displayName},
            branding = {branding},
            allow_session_duration_choice = {allowSessionDurationChoice},
            updated_at = {now}
      WHERE id = 1`,
    {
      displayName,
      branding,
      allowSessionDurationChoice: allowSessionDurationChoice ? 1 : 0,
      now,
    }
  );

  const updated = await loadSettingsRow(realmDb, realmSlug);
  return serializeSettings(updated, realmSlug);
}
