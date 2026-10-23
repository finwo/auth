// src/lib/config.js - configuration loading for the auth server
//
// Resolution order, lowest precedence first:
//   1. built-in defaults (see DEFAULTS)
//   2. YAML file, from ./auth.yaml when present
//   3. environment variables (see ENV_MAP)

import fs from 'node:fs';
import YAML from 'yaml';

const SUPPORTED_DIALECTS = ['sqlite'];

const DEFAULTS = {
  server: {
    host: '0.0.0.0',
    port: 3000,
    public_url: 'http://localhost:3000',
  },
  database: {
    dialect: 'sqlite',
    path: './data/system.sqlite',
    realms: './data/realms',
  },
  apps: {
    admin: null,
    account: null,
  },
  packages: {
    path: './data/packages',
    max_archive_bytes: 2097152,
    max_extracted_bytes: 10485760,
    max_files: 256,
  },
};

// [environment variable, dotted config path, parser]
const ENV_MAP = [
  ['AUTH_HOST', 'server.host', String],
  ['AUTH_PORT', 'server.port', toInt],
  ['AUTH_PUBLIC_URL', 'server.public_url', String],
  ['AUTH_DATABASE_DIALECT', 'database.dialect', lower],
  ['AUTH_DATABASE_PATH', 'database.path', String],
  ['AUTH_REALMS_PATH', 'database.realms', String],
  ['AUTH_ADMIN_APP_URL', 'apps.admin', String],
  ['AUTH_ACCOUNT_APP_URL', 'apps.account', String],
  ['AUTH_PACKAGES_PATH', 'packages.path', String],
  ['AUTH_PACKAGE_MAX_ARCHIVE_BYTES', 'packages.max_archive_bytes', toInt],
  ['AUTH_PACKAGE_MAX_EXTRACTED_BYTES', 'packages.max_extracted_bytes', toInt],
  ['AUTH_PACKAGE_MAX_FILES', 'packages.max_files', toInt],
];

function lower(v) {
  return String(v).trim().toLowerCase();
}

function toInt(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`expected an integer, got ${JSON.stringify(v)}`);
  return n;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, overlay) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(overlay || {})) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[last] = value;
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (isPlainObject(v) || Array.isArray(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}

function validate(cfg) {
  const errors = [];

  const port = cfg.server.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    errors.push(`server.port must be between 0 and 65535, got ${port}`);
  }

  try {
    const publicUrl = new URL(cfg.server.public_url);
    if (publicUrl.protocol !== 'http:' && publicUrl.protocol !== 'https:') {
      errors.push('server.public_url must use http or https');
    }
  } catch {
    errors.push('server.public_url must be an absolute URL');
  }

  if (!SUPPORTED_DIALECTS.includes(cfg.database.dialect)) {
    errors.push(
      `database.dialect must be one of ${SUPPORTED_DIALECTS.join(', ')}, got ${JSON.stringify(cfg.database.dialect)}`
    );
  }

  if (cfg.database.dialect === 'sqlite') {
    if (!cfg.database.path) {
      errors.push('database.path is required for sqlite (set database.path or AUTH_DATABASE_PATH)');
    }
    if (!cfg.database.realms) {
      errors.push('database.realms is required for sqlite (set database.realms or AUTH_REALMS_PATH)');
    }
  }

  for (const [name, value] of Object.entries(cfg.apps || {})) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        errors.push(`apps.${name} must use http or https`);
      }
      if (url.pathname !== '/' || url.search || url.hash) {
        errors.push(`apps.${name} must be an origin without a path`);
      }
    } catch {
      errors.push(`apps.${name} must be an absolute URL`);
    }
  }

  if (!cfg.packages?.path) {
    errors.push('packages.path is required (set packages.path or AUTH_PACKAGES_PATH)');
  }

  for (const name of ['max_archive_bytes', 'max_extracted_bytes', 'max_files']) {
    const value = cfg.packages?.[name];
    if (!Number.isInteger(value) || value < 1) {
      errors.push(`packages.${name} must be a positive integer, got ${value}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
}

export function loadConfig(explicitPath) {
  const file = explicitPath || 'auth.yaml';
  let cfg = structuredClone(DEFAULTS);
  let source = null;

  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    let parsed;
    try {
      parsed = YAML.parse(text) || {};
    } catch (e) {
      throw new Error(`failed to parse config file ${file}: ${e.message}`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`config file ${file} must contain a YAML mapping at the top level`);
    }
    cfg = deepMerge(cfg, parsed);
    source = file;
  } else if (explicitPath) {
    throw new Error(`config file not found: ${file}`);
  }

  for (const [env, dotted, parse] of ENV_MAP) {
    const raw = process.env[env];
    if (raw === undefined || raw === '') continue;
    try {
      setPath(cfg, dotted, parse(raw));
    } catch (e) {
      throw new Error(`invalid value for ${env}: ${e.message}`);
    }
  }

  cfg.source = source;

  validate(cfg);

  return deepFreeze(cfg);
}
