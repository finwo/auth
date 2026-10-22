CREATE TABLE app_bans (
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id)
);
