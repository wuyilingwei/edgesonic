CREATE TABLE IF NOT EXISTS clone_id_map (
  source_key TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('song', 'album', 'artist')),
  remote_id TEXT NOT NULL,
  local_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (source_key, item_type, remote_id)
);
