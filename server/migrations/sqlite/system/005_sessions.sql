CREATE TABLE session_groups (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  active_session_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX session_groups_host ON session_groups(host);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'realm', 'client')),
  scope_host TEXT NOT NULL,
  realm_id TEXT REFERENCES realms(id) ON DELETE CASCADE,
  client_id TEXT,
  ttl INTEGER NOT NULL,
  auth_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent TEXT,
  ip TEXT,
  UNIQUE (group_id, user_id)
);

CREATE INDEX sessions_group ON sessions(group_id);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);
CREATE INDEX sessions_scope ON sessions(scope_type, scope_host);

CREATE TABLE session_realms (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  realm_id TEXT NOT NULL REFERENCES realms(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT,
  PRIMARY KEY (session_id, realm_id)
);

CREATE INDEX session_realms_realm ON session_realms(realm_id);
