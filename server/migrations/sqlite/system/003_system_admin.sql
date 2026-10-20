ALTER TABLE users ADD COLUMN is_system_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_system_admin IN (0, 1));
