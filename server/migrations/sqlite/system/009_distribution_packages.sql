CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_email TEXT,
  digest TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  filename TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX packages_created ON packages(created_at);
CREATE INDEX packages_type ON packages(type);

DROP TABLE IF EXISTS realm_template_layers;
DROP TABLE IF EXISTS template_layers;

CREATE TABLE realm_template_layers (
  realm_id TEXT NOT NULL REFERENCES realms(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (realm_id, package_id),
  UNIQUE (realm_id, position)
);

CREATE INDEX realm_template_layers_package ON realm_template_layers(package_id);