CREATE TABLE template_layers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX template_layers_created ON template_layers(created_at);

CREATE TABLE realm_template_layers (
  realm_id TEXT NOT NULL REFERENCES realms(id) ON DELETE CASCADE,
  layer_id TEXT NOT NULL REFERENCES template_layers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (realm_id, layer_id),
  UNIQUE (realm_id, position)
);

CREATE INDEX realm_template_layers_layer ON realm_template_layers(layer_id);
