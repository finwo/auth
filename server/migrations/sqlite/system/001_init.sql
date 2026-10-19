CREATE TABLE realms (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  db_file TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE realm_domains (
  host TEXT PRIMARY KEY,
  realm_id TEXT NOT NULL REFERENCES realms(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX realm_domains_realm ON realm_domains(realm_id);
