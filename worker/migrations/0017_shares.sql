-- 044 Sharing — Subsonic share API
--
-- Two tables: shares (metadata) + share_entries (target song masters, ordered).
-- The expires_at column is unix seconds (NULL = never expires); even though the
-- Subsonic createShare API takes milliseconds, we normalise to seconds here to
-- align with every other timestamp in the schema.
--
-- The public route GET /share/:id increments view_count on every successful hit.

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  description TEXT,
  expires_at INTEGER,                          -- unix seconds; NULL = never expires
  view_count INTEGER NOT NULL DEFAULT 0,
  last_visited_at INTEGER,                     -- unix seconds; NULL until first view
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);

CREATE TABLE IF NOT EXISTS share_entries (
  share_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  song_master_id TEXT NOT NULL,
  PRIMARY KEY (share_id, position),
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE,
  FOREIGN KEY (song_master_id) REFERENCES song_masters(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_share_entries_song ON share_entries(song_master_id);

-- share permission: create/update/delete own shares.
-- level 0 (guest) cannot create shares; admin levels can.
INSERT OR IGNORE INTO user_permissions (level, permission, enabled, max_rph) VALUES
  (3, 'share', 1, 0),
  (2, 'share', 1, 0),
  (1, 'share', 1, 0),
  (0, 'share', 0, 0);
