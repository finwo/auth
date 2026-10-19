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
  },
  database: {
    dialect: 'sqlite',
    path: './data/system.sqlite',
    realms: './data/realms',
  },
};

// [environment variable, dotted config path, parser]
const ENV_MAP = [
  ['AUTH_HOST', 'server.host', String],
  ['AUTH_PORT', 'server.port', toInt],
  ['AUTH_DATABASE_DIALECT', 'database.dialect', lower],
  ['AUTH_DATABASE_PATH', 'database.path', String],
  ['AUTH_REALMS_PATH', 'database.realms', String],
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
