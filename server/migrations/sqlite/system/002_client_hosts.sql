CREATE TABLE oidc_client_hosts (
  host TEXT PRIMARY KEY,
  realm_id TEXT NOT NULL REFERENCES realms(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX oidc_client_hosts_realm ON oidc_client_hosts(realm_id);
