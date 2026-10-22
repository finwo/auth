CREATE TABLE client_consents (
  user_id TEXT NOT NULL,
  realm_id TEXT NOT NULL REFERENCES realms(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  granted_via TEXT NOT NULL CHECK (granted_via IN ('user', 'trusted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (user_id, realm_id, client_id)
);

CREATE INDEX client_consents_client ON client_consents(client_id);
CREATE INDEX client_consents_user ON client_consents(user_id);
