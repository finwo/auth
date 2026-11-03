CREATE TABLE system_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  branding TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO system_settings (id, branding, created_at, updated_at)
VALUES (
  1,
  '{}',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
