ALTER TABLE oidc_clients ADD COLUMN consent_mode TEXT NOT NULL DEFAULT 'remembered' CHECK (consent_mode IN ('remembered', 'trusted'));
