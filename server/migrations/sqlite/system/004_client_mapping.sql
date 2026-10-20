CREATE TABLE client_realms (
  client_id TEXT PRIMARY KEY,
  realm_id TEXT REFERENCES realms(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX client_realms_realm ON client_realms(realm_id);

INSERT INTO client_realms (client_id, realm_id, created_at)
SELECT client_id, realm_id, created_at
  FROM oidc_client_hosts;

CREATE TABLE oidc_client_hosts_new (
  host TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES client_realms(client_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

INSERT INTO oidc_client_hosts_new (host, client_id, created_at)
SELECT host, client_id, created_at
  FROM oidc_client_hosts;

DROP TABLE oidc_client_hosts;

ALTER TABLE oidc_client_hosts_new RENAME TO oidc_client_hosts;

CREATE INDEX oidc_client_hosts_client ON oidc_client_hosts(client_id);
