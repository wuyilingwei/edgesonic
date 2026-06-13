-- ============================================================================
-- 037 [Feature] Bookmarks + PlayQueue
-- ============================================================================
-- Per-user bookmarks (resume point per song) and a single saved play queue
-- per user (Subsonic getBookmarks / createBookmark / deleteBookmark /
-- getPlayQueue / savePlayQueue). Last-write-wins; no multi-device merge.
-- ============================================================================

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id TEXT NOT NULL,
  song_master_id TEXT NOT NULL,
  position_ms INTEGER NOT NULL,
  comment TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, song_master_id),
  FOREIGN KEY (user_id) REFERENCES users(username) ON DELETE CASCADE,
  FOREIGN KEY (song_master_id) REFERENCES song_masters(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks (user_id);

CREATE TABLE IF NOT EXISTS play_queues (
  user_id TEXT PRIMARY KEY,
  song_ids TEXT NOT NULL,           -- JSON array of song_master_ids (preserves order)
  current_id TEXT,                  -- song_master_id of currently playing entry
  position_ms INTEGER NOT NULL DEFAULT 0,
  changed_by TEXT,                  -- Subsonic client name / device
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(username) ON DELETE CASCADE
);
