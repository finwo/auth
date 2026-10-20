CREATE TABLE realms (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  db_file TEXT,
  owner_user_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE realm_hosts (
  host TEXT PRIMARY KEY,
  realm_id TEXT NOT NULL REFERENCES realms(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX realm_hosts_realm ON realm_hosts(realm_id);

CREATE TABLE realm_email_domains (
  domain TEXT PRIMARY KEY,
  realm_id TEXT NOT NULL REFERENCES realms(id) ON DELETE CASCADE,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  verification_token TEXT,
  verified_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX realm_email_domains_realm ON realm_email_domains(realm_id);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  home_realm_id TEXT REFERENCES realms(id),
  profile TEXT NOT NULL DEFAULT '{}',
  last_login_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX users_home_realm ON users(home_realm_id);

CREATE TABLE user_emails (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);

CREATE INDEX user_emails_user ON user_emails(user_id);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, type)
);

CREATE INDEX credentials_user ON credentials(user_id);
