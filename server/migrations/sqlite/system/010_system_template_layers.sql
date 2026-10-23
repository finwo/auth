CREATE TABLE system_template_layers (
  package_id TEXT PRIMARY KEY REFERENCES packages(id) ON DELETE CASCADE,
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0)
);
