ALTER TABLE oidc_clients ADD COLUMN branding TEXT NOT NULL DEFAULT '{}';
ALTER TABLE oidc_clients ADD COLUMN client_secret_hash TEXT;
ALTER TABLE oidc_clients ADD COLUMN token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none';
ALTER TABLE oidc_clients ADD COLUMN require_pkce INTEGER NOT NULL DEFAULT 1;
ALTER TABLE oidc_clients ADD COLUMN post_logout_redirect_uris TEXT NOT NULL DEFAULT '[]';

CREATE TABLE signing_keys (
  id TEXT PRIMARY KEY,
  alg TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);

CREATE INDEX signing_keys_status ON signing_keys(status);

CREATE TABLE auth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT,
  nonce TEXT,
  code_challenge TEXT,
  code_challenge_method TEXT,
  session_id TEXT,
  user_id TEXT,
  auth_time INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX auth_requests_expires ON auth_requests(expires_at);

CREATE TABLE authorization_codes (
  id TEXT PRIMARY KEY,
  auth_request_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  nonce TEXT,
  code_challenge TEXT,
  code_challenge_method TEXT,
  session_id TEXT,
  auth_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX authorization_codes_expires ON authorization_codes(expires_at);
