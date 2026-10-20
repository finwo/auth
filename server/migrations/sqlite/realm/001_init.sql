CREATE TABLE realm_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'realm' CHECK (kind IN ('realm', 'system')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  branding TEXT NOT NULL DEFAULT '{}',
  allow_session_duration_choice INTEGER NOT NULL DEFAULT 1 CHECK (allow_session_duration_choice IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE realm_memberships (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'invited')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE membership_roles (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX membership_roles_role ON membership_roles(role_id);

CREATE TABLE identity_providers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT,
  scopes TEXT NOT NULL DEFAULT 'openid email profile',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE email_domain_providers (
  domain TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES identity_providers(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX email_domain_providers_provider ON email_domain_providers(provider_id);

CREATE TABLE oidc_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  scopes TEXT NOT NULL DEFAULT 'openid profile email',
  access_mode TEXT NOT NULL DEFAULT 'members' CHECK (access_mode IN ('internal', 'members', 'public')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE oidc_client_roles (
  client_id TEXT NOT NULL REFERENCES oidc_clients(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (client_id, role_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ttl INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent TEXT,
  ip TEXT
);

CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);
